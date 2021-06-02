from common.command import run_cmd_async_at, run_cmd_async
from common.fio import Fio
from common.volume import Volume
from common.hdl import MayastorHandle
import logging
import pytest
import uuid as guid
import grpc
import asyncio
import mayastor_pb2 as pb
from common.nvme import (
    nvme_discover,
    nvme_connect,
    nvme_disconnect,
    nvme_remote_connect,
    nvme_remote_disconnect)

@pytest.fixture
def create_nexus(wait_for_mayastor, containers, nexus_uuid, create_replica):
    hdls = wait_for_mayastor
    replicas = create_replica
    replicas = [k.uri for k in replicas]

    NEXUS_UUID, size_mb = nexus_uuid

    hdls['ms3'].nexus_create(NEXUS_UUID, 64 * 1024 * 1024, replicas)
    uri = hdls['ms3'].nexus_publish(NEXUS_UUID)
    assert len(hdls['ms1'].bdev_list()) == 2
    assert len(hdls['ms2'].bdev_list()) == 2
    assert len(hdls['ms3'].bdev_list()) == 1

    assert len(hdls['ms1'].pool_list().pools) == 1
    assert len(hdls['ms2'].pool_list().pools) == 1

    yield uri
    hdls['ms3'].nexus_destroy(NEXUS_UUID)

@pytest.fixture
def pool_config():
    """
    The idea is this used to obtain the pool types and names that should be
    created.
    """
    pool = {}
    pool['name'] = "tpool"
    pool['uri'] = "malloc:///disk0?size_mb=100"
    return pool


@pytest.fixture(scope="module")
def containers(docker_project, module_scoped_container_getter):
    """Fixture to get handles to mayastor as well as the containers."""
    project = docker_project
    containers = {}
    for name in project.service_names:
        containers[name] = module_scoped_container_getter.get(name)
    yield containers


@pytest.fixture(scope="module")
def wait_for_mayastor(docker_project, module_scoped_container_getter):
    """Fixture to get a reference to mayastor gRPC handles"""
    project = docker_project
    handles = {}
    for name in project.service_names:
        # because we use static networks .get_service() does not work
        services = module_scoped_container_getter.get(name)
        ip_v4 = services.get(
            "NetworkSettings.Networks.python_mayastor_net.IPAddress")
        handles[name] = MayastorHandle(ip_v4)
    yield handles


@pytest.fixture
def replica_uuid():
    """Replica UUID's to be used."""
    UUID = "0000000-0000-0000-0000-000000000001"
    size_mb = 64 * 1024 * 1024
    return (UUID, size_mb)


@pytest.fixture
def nexus_uuid():
    """Nexus UUID's to be used."""
    NEXUS_UUID = "3ae73410-6136-4430-a7b5-cbec9fe2d273"
    size_mb = 64 * 1024 * 1024
    return (NEXUS_UUID, size_mb)


@pytest.fixture
def create_pools(
        wait_for_mayastor,
        containers,
        pool_config):
    hdls = wait_for_mayastor

    cfg = pool_config
    pools = []

    pools.append(hdls['ms1'].pool_create(cfg.get('name'),
                                         cfg.get('uri')))

    pools.append(hdls['ms2'].pool_create(cfg.get('name'),
                                         cfg.get('uri')))

    for p in pools:
        assert p.state == pb.POOL_ONLINE
    yield pools
    try:
        hdls['ms1'].pool_destroy(cfg.get('name'))
        hdls['ms2'].pool_destroy(cfg.get('name'))
    except Exception:
        pass


@pytest.fixture
def create_replica(
        wait_for_mayastor,
        pool_config,
        replica_uuid,
        create_pools):
    hdls = wait_for_mayastor
    pools = create_pools
    replicas = []

    UUID, size_mb = replica_uuid

    replicas.append(hdls['ms1'].replica_create(pools[0].name,
                                               UUID, size_mb))
    replicas.append(hdls['ms2'].replica_create(pools[0].name,
                                               UUID, size_mb))

    yield replicas
    try:
        hdls['ms1'].replica_destroy(UUID)
        hdls['ms2'].replica_destroy(UUID)
    except Exception as e:
        logging.debug(e)


@pytest.mark.skip
@pytest.fixture
def destroy_all(wait_for_mayastor):
    hdls = wait_for_mayastor

    hdls["ms3"].nexus_destroy(NEXUS_UUID)

    hdls["ms1"].replica_destroy(UUID)
    hdls["ms2"].replica_destroy(UUID)

    hdls["ms1"].pool_destroy("tpool")
    hdls["ms2"].pool_destroy("tpool")

    hdls["ms1"].replica_destroy(UUID)
    hdls["ms2"].replica_destroy(UUID)
    hdls["ms3"].nexus_destroy(NEXUS_UUID)

    hdls["ms1"].pool_destroy("tpool")
    hdls["ms2"].pool_destroy("tpool")

    assert len(hdls["ms1"].pool_list().pools) == 0
    assert len(hdls["ms2"].pool_list().pools) == 0

    assert len(hdls["ms1"].bdev_list().bdevs) == 0
    assert len(hdls["ms2"].bdev_list().bdevs) == 0
    assert len(hdls["ms3"].bdev_list().bdevs) == 0


@pytest.mark.skip
def test_multi_volume_local(wait_for_mayastor, create_pools):
    hdls = wait_for_mayastor
    # contains the replicas

    ms = hdls.get('ms1')

    for i in range(6):
        uuid = guid.uuid4()
        replicas = []

        ms.replica_create("tpool", uuid, 8 * 1024 * 1024)

        replicas.append("bdev:///{}".format(uuid))
        print(ms.nexus_create(uuid, 4 * 1024 * 1024, replicas))


@pytest.mark.parametrize("times", range(50))
@pytest.mark.skip
def test_create_nexus_with_two_replica(times, create_nexus):
    nexus, uri, hdls = create_nexus
    nvme_discover(uri.device_uri)
    nvme_connect(uri.device_uri)
    nvme_disconnect(uri.device_uri)
    destroy_all


@pytest.mark.skip
def test_enospace_on_volume(wait_for_mayastor, create_pools):
    nodes = wait_for_mayastor
    pools = []
    uuid = guid.uuid4()

    pools.append(nodes["ms2"].pools_as_uris()[0])
    pools.append(nodes["ms1"].pools_as_uris()[0])
    nexus_node = nodes["ms3"].as_target()

    v = Volume(uuid, nexus_node, pools, 100 * 1024 * 1024)

    with pytest.raises(grpc.RpcError, match='RESOURCE_EXHAUSTED'):
        _ = v.create()
    print("expected failed")


async def kill_after(container, sec):
    """Kill the given container after sec seconds."""
    await asyncio.sleep(sec)
    logging.info(f"killing container {container}")
    container.kill()


@pytest.mark.skip
@pytest.mark.asyncio
@pytest.mark.timeout(60)
async def test_nexus_2_mirror_kill_one(containers, create_nexus):

    to_kill = containers.get("ms2")
    uri = create_nexus

    nvme_discover(uri)
    dev = nvme_connect(uri)
    job = Fio("job1", "rw", dev).build()

    await asyncio.gather(run_cmd_async(job), kill_after(to_kill, 5))

    nvme_disconnect(uri)


@pytest.mark.asyncio
@pytest.mark.timeout(60)
async def test_nexus_2_remote_mirror_kill_one(target_vm,
                                              containers, nexus_uuid, wait_for_mayastor, create_nexus):

    """
    This test does the following steps:

        - creates mayastor instances
        - creates pools on mayastor 1 and 2
        - creates replicas on those pools
        - creates a nexus on mayastor 3
        - starts fio on a remote VM (vixos1) for 15 secondsj
        - kills mayastor 2 after 4 seconds
        - assume the test to succeed
        - disconnect the VM from mayastor 3 when FIO completes
        - removes the nexus from mayastor 3
        - removes the replicas but as mayastor 2 is down, will swallow errors
        - removes the pool

    The bulk of this is done by reusing fixtures those fitures are not as
    generic as one might like at this point so look/determine if you need them
    to begin with.

    By yielding from fixtures, after the tests the function is resumed where
    yield is called.
    """

    uri = create_nexus
    NEXUS_UUID, size_mb = nexus_uuid
    dev = await nvme_remote_connect(target_vm, uri)
    job = Fio("job1", "randwrite", dev).build()

    # create an event loop polling the async processes for completion
    await asyncio.gather(
        run_cmd_async_at(target_vm, job),
        kill_after(containers.get("ms2"), 4))

    list = wait_for_mayastor.get("ms3").nexus_list()
    nexus = next(n for n in list if n.uuid == NEXUS_UUID)
    assert nexus.state == pb.NEXUS_DEGRADED
    nexus.children[1].state == pb.CHILD_FAULTED

    # disconnect the VM from our target before we shutdown
    await nvme_remote_disconnect(target_vm, uri)
