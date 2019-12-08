// Unit tests for nexus grpc api. Nexus is basically a hub which does IO
// replication to connected replicas. We test nexus operations with all
// supported replica types: nvmf, iscsi, bdev and aio. aio is not used in
// the product but it was part of initial implementation so we keep it in
// case it would be useful in future.

'use strict';

const assert = require('chai').assert;
const async = require('async');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { createClient } = require('grpc-kit');
const grpc = require('grpc');
const common = require('./test_common');

// just some UUID used for nexus ID
const UUID = 'dbe4d7eb-118a-4d15-b789-a18d9af6ff21';
const UUID2 = 'dbe4d7eb-118a-4d15-b789-a18d9af6ff22';

// backend file for aio bdev
const aioFile = '/tmp/aio-backend';
// 64MB is the size of nexus and replicas
const diskSize = 64 * 1024 * 1024;
// external IP address detected by common lib
const externIp = common.getMyIp();

// Instead of using mayastor grpc methods to create replicas we use a config
// file to create them. Advantage is that we don't depend on bugs in replica
// code (the nexus tests are more independent). Disadvantage is that we don't
// test the nexus with implementation of replicas which are used in the
// production.
const configNexus = `
[Malloc]
  NumberOfLuns 2
  LunSizeInMB  64
  BlockSize    4096

[iSCSI]
  NodeBase "iqn.2019-05.io.openebs"
  # Socket I/O timeout sec. (0 is infinite)
  Timeout 30
  DiscoveryAuthMethod None
  DefaultTime2Wait 2
  DefaultTime2Retain 60
  ImmediateData Yes
  ErrorRecoveryLevel 0
  # Reduce mem requirements for iSCSI
  MaxSessions 1
  MaxConnectionsPerSession 1

[PortalGroup1]
  Portal GR1 0.0.0.0:3261

[InitiatorGroup1]
  InitiatorName Any
  Netmask ${externIp}/24

[TargetNode0]
  TargetName "iqn.2019-05.io.openebs:disk1"
  TargetAlias "Backend Malloc1"
  Mapping PortalGroup1 InitiatorGroup1
  AuthMethod None
  UseDigest Auto
  LUN0 Malloc1
  QueueDepth 1
`;

// The config just for nvmf target which cannot run in the same process as
// the nvmf initiator (SPDK limitation).
const configNvmfTarget = `
[Malloc]
  NumberOfLuns 1
  LunSizeInMB  64
  BlockSize    4096

[Nvmf]
  AcceptorPollRate 10000
  ConnectionScheduler RoundRobin

[Transport]
  Type TCP
  # reduce memory requirements
  NumSharedBuffers 32

[Subsystem1]
  NQN nqn.2019-05.io.openebs:disk2
  Listen TCP 127.0.0.1:8420
  AllowAnyHost Yes
  SN MAYASTOR0000000001
  MN NEXUSController1
  MaxNamespaces 1
  Namespace Malloc0 1

# although not used we still have to reduce mem requirements for iSCSI
[iSCSI]
  MaxSessions 1
  MaxConnectionsPerSession 1
`;

function createGrpcClient(service) {
  return createClient(
    {
      protoPath: path.join(
        __dirname,
        '..',
        'rpc',
        'proto',
        'mayastor_service.proto'
      ),
      packageName: 'mayastor_service',
      serviceName: 'Mayastor',
      options: {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      },
    },
    common.endpoint
  );
}

describe('nexus', function() {
  var client;
  var nbd_device;

  this.timeout(10000); // for network tests we need long timeouts

  before(done => {
    client = createGrpcClient('MayaStor');
    if (!client) {
      return done(new Error('Failed to initialize grpc client'));
    }

    async.series(
      [
        common.ensureNbdWritable,
        next => {
          fs.writeFile(aioFile, '', next);
        },
        next => {
          fs.truncate(aioFile, diskSize, next);
        },
        next => {
          // Start two spdk instances. The first one will hold the remote
          // nvmf target and the second one everything including nexus.
          // We must do this because if nvme initiator and target are in
          // the same instance, the SPDK will hang.
          //
          // In order not to exceed available memory in hugepages when running
          // two instances we use the -s option to limit allocated mem.
          common.startSpdk(configNvmfTarget, [
            '-r',
            '/tmp/target.sock',
            '-s',
            '128',
          ]);
          common.startMayastor(configNexus, ['-r', common.SOCK, '-s', '386']);
          common.startMayastorGrpc();
          common.waitFor(pingDone => {
            // use harmless method to test if the mayastor is up and running
            client.listPools({}, pingDone);
          }, next);
        },
      ],
      done
    );
  });

  after(done => {
    async.series(
      [
        common.stopAll,
        common.restoreNbdPerms,
        next => {
          fs.unlink(aioFile, err => next());
        },
      ],
      err => {
        if (client != null) {
          client.close();
        }
        done(err);
      }
    );
  });

  it('should create a nexus using all types of replicas', done => {
    let args = {
      uuid: UUID,
      size: diskSize,
      children: [
        'bdev:///Malloc0',
        `aio:///${aioFile}?blk_size=4096`,
        `iscsi://${externIp}:3261/iqn.2019-05.io.openebs:disk1`,
        `nvmf://127.0.0.1:8420/nqn.2019-05.io.openebs:disk2`,
      ],
    };

    client.CreateNexus(args, done);
  });

  it('should list the created nexus', done => {
    client.ListNexus({}, (err, res) => {
      if (err) return done(err);
      assert.lengthOf(res.nexus_list, 1);

      let nexus = res.nexus_list[0];

      assert.equal(nexus.uuid, UUID);
      assert.equal(nexus.state, 'online');
      assert.lengthOf(nexus.children, 4);
      assert.equal(nexus.children[0].uri, 'bdev:///Malloc0');
      assert.equal(nexus.children[0].state, 'open');
      assert.equal(nexus.children[1].uri, `aio:///${aioFile}?blk_size=4096`);
      assert.equal(nexus.children[1].state, 'open');
      assert.equal(
        nexus.children[2].uri,
        `iscsi://${externIp}:3261/iqn.2019-05.io.openebs:disk1`
      );
      assert.equal(nexus.children[2].state, 'open');
      assert.equal(
        nexus.children[3].uri,
        `nvmf://127.0.0.1:8420/nqn.2019-05.io.openebs:disk2`
      );
      assert.equal(nexus.children[3].state, 'open');
      done();
    });
  });

  it('should be able to remove one of its children', done => {
    let args = {
      uuid: UUID,
      uri: `nvmf://127.0.0.1:8420/nqn.2019-05.io.openebs:disk2`,
    };

    client.RemoveChildNexus(args, err => {
      if (err) return done(err);

      client.ListNexus({}, (err, res) => {
        if (err) return done(err);
        let nexus = res.nexus_list[0];
        assert.lengthOf(nexus.children, 3);
        assert(!nexus.children.find(ch => ch.uri.match(/^nvmf:/)));
        done();
      });
    });
  });

  it('should be able to add the child back', done => {
    let args = {
      uuid: UUID,
      uri: `nvmf://127.0.0.1:8420/nqn.2019-05.io.openebs:disk2`,
    };

    client.AddChildNexus(args, err => {
      if (err) return done(err);

      client.ListNexus({}, (err, res) => {
        if (err) return done(err);
        let nexus = res.nexus_list[0];
        assert.lengthOf(nexus.children, 4);
        assert(nexus.children.find(ch => ch.uri.match(/^nvmf:/)));
        done();
      });
    });
  });

  // It is questionable if this should succeed but it's the way how the things
  // work currently.
  it('should succeed creating the same nexus nexus again and with different URIs', done => {
    let args = {
      uuid: UUID,
      size: 131072,
      children: [
        `iscsi://${externIp}:3261/iqn.2019-05.io.openebs:disk2`,
        `iscsi://${externIp}:3261/iqn.2019-05.io.openebs:disk3`,
      ],
    };

    client.CreateNexus(args, done);
  });

  it('should fail to create another nexus with in use URIs', done => {
    let args = {
      uuid: UUID2,
      size: 131072,
      children: [`iscsi://${externIp}:3261/iqn.2019-05.io.openebs:disk1`],
    };

    client.CreateNexus(args, (err, res) => {
      if (!err) return done(new Error('Expected error'));
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      done();
    });
  });

  it('should fail creating a nexus with non existing URIs', done => {
    let args = {
      uuid: UUID2,
      size: 131072,
      children: [
        `iscsi://${externIp}:3261/iqn.2019-05.io.spdk:disk2`,
        `nvmf://127.0.0.1:8420/nqn.2019-05.io.openebs:disk3`,
      ],
    };

    client.CreateNexus(args, (err, res) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      done();
    });
  });

  it('should publish the nexus using nbd', done => {
    client.PublishNexus({ uuid: UUID }, (err, res) => {
      assert(res.device_path);
      nbd_device = res.device_path;
      done();
    });
  });

  it('should unpublish the nexus device', done => {
    client.unpublishNexus({ uuid: UUID }, done);
  });

  it('should publish the nexus using nbd and a crypto key', done => {
    client.PublishNexus({ uuid: UUID, key: '0123456789123456' }, (err, res) => {
      assert(res.device_path);
      nbd_device = res.device_path;
      done();
    });
  });

  it('should write to the nbd device', done => {
    fs.open(nbd_device, 'w', 666, (err, fd) => {
      if (err) return done(err);
      let buffer = Buffer.alloc(512, 'z', 'utf8');
      fs.write(fd, buffer, 0, 512, (err, nr, buffer) => {
        if (err) return done(err);
        assert(nr === 512);
        assert(buffer[0] === 122);
        assert(buffer[511] === 122);
        fs.fsync(fd, err => {
          if (err) done(err);
          fs.close(fd, () => {
            done();
          });
        });
      });
    });
  });

  it('should read the written data back', done => {
    fs.open(nbd_device, 'r', 666, (err, fd) => {
      if (err) done(err);
      let buffer = Buffer.alloc(512, 'a', 'utf8');

      fs.read(fd, buffer, 0, 512, 0, (err, nr, buffer) => {
        if (err) done(err);
        buffer.forEach(function(e) {
          assert(e === 122);
        });
        fs.close(fd, () => {
          done();
        });
      });
    });
  });

  it('should destroy the nexus without unpublishing it', done => {
    client.DestroyNexus({ uuid: UUID }, err => {
      if (err) return done(err);

      client.ListNexus({}, (err, res) => {
        if (err) return done(err);
        assert.lengthOf(res.nexus_list, 0);
        done();
      });
    });
  });

  it('should fail to create a nexus with mixed block sizes', done => {
    let args = {
      uuid: UUID,
      size: 131072,
      children: [
        `iscsi://${externIp}:3261/iqn.2019-05.io.openebs:disk1`,
        `aio:///${aioFile}?blk_size=512`,
      ],
    };
    client.CreateNexus(args, (err, data) => {
      if (!err) return done(new Error('Expected error'));
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      done();
    });
  });

  it('should fail to create a nexus with size larger than any of its replicas', done => {
    let args = {
      uuid: UUID,
      size: 2 * diskSize,
      children: [
        `iscsi://${externIp}:3261/iqn.2019-05.io.openebs:disk1`,
        `nvmf://127.0.0.1:8420/nqn.2019-05.io.openebs:disk2`,
      ],
    };

    client.CreateNexus(args, (err, data) => {
      if (!err) return done(new Error('Expected error'));
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      done();
    });
  });
});