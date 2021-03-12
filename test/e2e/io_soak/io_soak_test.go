// JIRA: MQ-25
// JIRA: MQ-26
package io_soak

import (
	"e2e-basic/common"
	"e2e-basic/common/e2e_config"
	corev1 "k8s.io/api/core/v1"

	"fmt"
	"sort"
	"testing"
	"time"

	. "github.com/onsi/ginkgo"
	. "github.com/onsi/gomega"

	logf "sigs.k8s.io/controller-runtime/pkg/log"
)

var scNames []string
var jobs []IoSoakJob

func TestIOSoak(t *testing.T) {
	// Initialise test and set class and file names for reports
	common.InitTesting(t, "IO soak test, NVMe-oF TCP and iSCSI", "io-soak")
}

func monitor() error {
	var err error
	var failedJobs []string
	jobMap := make(map[string]IoSoakJob)
	for _, job := range jobs {
		jobMap[job.getPodName()] = job
	}

	logf.Log.Info("IOSoakTest monitor, checking mayastor and test pods", "jobCount", len(jobMap))
	for ; len(jobMap) !=0 && len(failedJobs) == 0; {
		time.Sleep(29 * time.Second)
		err = common.CheckPods(common.NSMayastor)
		if err != nil {
			logf.Log.Info("IOSoakTest monitor", "namespace", common.NSMayastor, "error", err)
			break
		}
		err = common.CheckPods(common.NSDefault)
		if err != nil {
			logf.Log.Info("IOSoakTest monitor", "namespace", common.NSDefault, "error", err)
			break
		}

		podNames := make([]string, len(jobMap))
		{
			ix := 0
			for k := range jobMap {
				podNames[ix] = k
				ix += 1
			}
		}

		podsRunning := 0
		podsSucceeded := 0
		podsFailed := 0
		for _, podName := range podNames {
			res,err := common.CheckPodCompleted(podName, common.NSDefault)
			if err != nil {
				logf.Log.Info("Failed to access pod status", "podName", podName, "error", err)
				break
			} else {
				switch res  {
				case corev1.PodPending:
					logf.Log.Info("Unexpected! pod status pending", "podName", podName)
				case corev1.PodRunning:
					podsRunning += 1
				case corev1.PodSucceeded:
					logf.Log.Info("Pod completed successfully", "podName", podName)
					delete(jobMap, podName)
					podsSucceeded += 1
				case corev1.PodFailed:
					logf.Log.Info("Pod completed with failures", "podName", podName)
					delete(jobMap, podName)
					failedJobs = append(failedJobs, podName)
					podsFailed += 1
				case corev1.PodUnknown:
					logf.Log.Info("Unexpected! pod status is unknown", "podName", podName)
				}
			}
		}
		logf.Log.Info("IO Soak test pods", "Running", podsRunning, "Succeeded", podsSucceeded, "Failed", podsFailed)
	}

	if err == nil && len(failedJobs) != 0 {
		err = fmt.Errorf("failed jobs %v", failedJobs)
	}
	return err
}

/// proto - protocol "nvmf" or "isci"
/// replicas - number of replicas for each volume
/// loadFactor - number of volumes for each mayastor instance
func IOSoakTest(protocols []common.ShareProto, replicas int, loadFactor int, duration time.Duration, disruptorCount int) {
	nodeList, err := common.GetNodeLocs()
	Expect(err).ToNot(HaveOccurred())

	var nodes []string

	numMayastorNodes := 0
	jobCount := 0
	sort.Slice(nodeList, func(i, j int) bool { return nodeList[i].NodeName < nodeList[j].NodeName })
	for i, node := range nodeList {
		if node.MayastorNode && !node.MasterNode {
			logf.Log.Info("MayastorNode", "name", node.NodeName, "index", i)
			jobCount += loadFactor
			numMayastorNodes += 1
			nodes = append(nodes, node.NodeName)
		}
	}

	jobCount -= disruptorCount

	for i, node := range nodes {
		if i%2 == 0 {
			common.LabelNode(node, NodeSelectorKey, NodeSelectorAppValue)
		}
	}

	Expect(replicas <= numMayastorNodes).To(BeTrue())
	logf.Log.Info("IOSoakTest", "jobs", jobCount, "volumes", jobCount, "test pods", jobCount)

	for _, proto := range protocols {
		scName := fmt.Sprintf("io-soak-%s", proto)
		logf.Log.Info("Creating", "storage class", scName)
		err = common.MkStorageClass(scName, replicas, proto, common.NSDefault)
		Expect(err).ToNot(HaveOccurred())
		scNames = append(scNames, scName)
	}

	// Create the set of jobs
	idx := 1
	for idx <= jobCount {
		for _, scName := range scNames {
			if idx > jobCount {
				break
			}
			logf.Log.Info("Creating", "job", "fio filesystem job", "id", idx)
			jobs = append(jobs, MakeFioFsJob(scName, idx, duration))
			idx++

			if idx > jobCount {
				break
			}
			logf.Log.Info("Creating", "job", "fio raw block job", "id", idx)
			jobs = append(jobs, MakeFioRawBlockJob(scName, idx, duration))
			idx++
		}
	}

	logf.Log.Info("Creating volumes")
	// Create the job volumes
	for _, job := range jobs {
		job.makeVolume()
	}

	logf.Log.Info("Creating test pods")
	// Create the job test pods
	for _, job := range jobs {
		pod, err := job.makeTestPod(AppNodeSelector)
		Expect(err).ToNot(HaveOccurred())
		Expect(pod).ToNot(BeNil())
	}

	// Empirically allocated PodReadyTime seconds for each pod to transition to ready
	timeoutSecs := PodReadyTime * len(jobs)
	if timeoutSecs < 60 {
		timeoutSecs = 60
	}
	logf.Log.Info("Waiting for test pods to be ready", "timeout seconds", timeoutSecs, "jobCount", len(jobs))

	// Wait for the test pods to be ready
	allReady := false
	for to:=0; to< timeoutSecs && !allReady; to+=1 {
		time.Sleep(1* time.Second)
		allReady = true
		for _, job := range jobs {
			allReady = allReady && common.IsPodRunning(job.getPodName(), common.NSDefault)
		}
	}
	Expect(allReady).To(BeTrue(), "Timeout waiting to jobs to be ready")

	logf.Log.Info("Starting disruptor pods")
	DisruptorsInit(protocols, replicas)
	MakeDisruptors()

	logf.Log.Info("Waiting for test execution to complete on all test pods")
	err = monitor()
	Expect(err).To(BeNil(), "Failed runs")

	logf.Log.Info("All runs complete, deleting test pods")
	DestroyDisruptors()
	DisruptorsDeinit()

	for _, job := range jobs {
		err := job.removeTestPod()
		Expect(err).ToNot(HaveOccurred())
	}

	logf.Log.Info("All runs complete, deleting volumes")
	for _, job := range jobs {
		job.removeVolume()
	}

	logf.Log.Info("All runs complete, deleting storage classes")
	for _, scName := range scNames {
		err = common.RmStorageClass(scName)
		Expect(err).ToNot(HaveOccurred())
	}

	for i, node := range nodes {
		if i%2 == 0 {
			common.UnlabelNode(node, NodeSelectorKey)
		}
	}
}

var _ = Describe("Mayastor Volume IO soak test", func() {

	AfterEach(func() {
		logf.Log.Info("AfterEach")
		// Check resource leakage.
		err := common.AfterEachCheck()
		Expect(err).ToNot(HaveOccurred())
	})

	It("should verify mayastor can process IO on multiple volumes simultaneously using NVMe-oF TCP", func() {
		e2eCfg := e2e_config.GetConfig()
		loadFactor := e2eCfg.IOSoakTest.LoadFactor
		replicas := e2eCfg.IOSoakTest.Replicas
		strProtocols := e2eCfg.IOSoakTest.Protocols
		disruptorCount := e2eCfg.IOSoakTest.Disrupt.PodCount
		var protocols []common.ShareProto
		for _, proto := range strProtocols {
			protocols = append(protocols, common.ShareProto(proto))
		}
		duration, err := time.ParseDuration(e2eCfg.IOSoakTest.Duration)
		Expect(err).ToNot(HaveOccurred(), "Duration configuration string format is invalid.")
		logf.Log.Info("Parameters",
			"replicas", replicas, "loadFactor", loadFactor,
			"duration", duration,
			"disrupt", e2eCfg.IOSoakTest.Disrupt)
		IOSoakTest(protocols, replicas, loadFactor, duration, disruptorCount)
	})
})

var _ = BeforeSuite(func(done Done) {
	common.SetupTestEnv()

	close(done)
}, 60)

var _ = AfterSuite(func() {
	// NB This only tears down the local structures for talking to the cluster,
	// not the kubernetes cluster itself.	By("tearing down the test environment")
	common.TeardownTestEnv()
})
