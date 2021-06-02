// gRPC client related utilities

import assert from 'assert';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

import { Logger } from './logger';
import { ServiceClientConstructor } from '@grpc/grpc-js/build/src/make-client';

const log = Logger('grpc');

const MAYASTOR_PROTO_PATH: string = path.join(__dirname, '../proto/mayastor.proto');

// Result of loadPackageDefinition() when run on mayastor proto file.
class MayastorDef {
  // Constructor for mayastor grpc service client.
  clientConstructor: ServiceClientConstructor;
  // All enums that occur in mayastor proto file indexed by name
  enums: Record<string, number>;

  constructor() {
    // Load mayastor proto file
    const proto = loadSync(MAYASTOR_PROTO_PATH, {
      // this is to load google/descriptor.proto
      includeDirs: ['./node_modules/protobufjs'],
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true
    });

    const pkgDef = grpc.loadPackageDefinition(proto).mayastor as grpc.GrpcObject;
    assert(pkgDef && pkgDef.Mayastor !== undefined);
    this.clientConstructor = pkgDef.Mayastor as ServiceClientConstructor;
    this.enums = {};
    Object.values(pkgDef).forEach((ent: any) => {
      if (ent.format && ent.format.indexOf('EnumDescriptorProto') >= 0) {
        ent.type.value.forEach((variant: any) => {
          this.enums[variant.name] = variant.number;
        });
      }
    });
  }
}

export const mayastor = new MayastorDef();

// This whole dance is done to satisfy typescript's type checking
// (not all values in grpc.status are numbers)
export const grpcCode: Record<string, number> = (() => {
  let codes: Record<string, number> = {};
  for (let prop in grpc.status) {
    let val = grpc.status[prop];
    if (typeof val === 'number') {
      codes[prop] = val;
    }
  }
  return codes;
})();

// Grpc error object.
//
// List of grpc status codes:
//   OK: 0,
//   CANCELLED: 1,
//   UNKNOWN: 2,
//   INVALID_ARGUMENT: 3,
//   DEADLINE_EXCEEDED: 4,
//   NOT_FOUND: 5,
//   ALREADY_EXISTS: 6,
//   PERMISSION_DENIED: 7,
//   RESOURCE_EXHAUSTED: 8,
//   FAILED_PRECONDITION: 9,
//   ABORTED: 10,
//   OUT_OF_RANGE: 11,
//   UNIMPLEMENTED: 12,
//   INTERNAL: 13,
//   UNAVAILABLE: 14,
//   DATA_LOSS: 15,
//   UNAUTHENTICATED: 16
//
export class GrpcError extends Error {
  code: number;

  constructor (code: number, msg: string) {
    assert(Object.values(grpcCode).indexOf(code) >= 0);
    super(msg);
    this.code = code;
  }
}

// Implementation of gRPC client encapsulating common code for calling a grpc
// method on a storage node (the node running mayastor).
export class GrpcClient {
  handle: any;

  // Create promise-friendly grpc client handle.
  //
  // @param endpoint   Host and port that mayastor server listens on.
  constructor (endpoint: string) {
    this.handle = new mayastor.clientConstructor(
      endpoint,
      grpc.credentials.createInsecure()
    );
  }

  // Call a grpc method with arguments.
  //
  // @param method   Name of the grpc method.
  // @param args     Arguments of the grpc method.
  // @returns Return value of the grpc method.
  call (method: string, args: any): Promise<any> {
    log.trace(
      `Calling grpc method ${method} with arguments: ${JSON.stringify(args)}`
    );
    return new Promise((resolve, reject) => {
      this.handle[method](args, (err: Error, val: any) => {
        if (err) {
          log.trace(`Grpc method ${method} failed: ${err}`);
          reject(err);
        } else {
          log.trace(`Grpc method ${method} returned: ${JSON.stringify(val)}`);
          resolve(val);
        }
      });
    });
  }

  // Close the grpc handle. The client should not be used after that.
  close () {
    this.handle.close();
  }
}