import { performance } from 'node:perf_hooks';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { HealthImplementation } from 'grpc-health-check';
import type { BidService } from '../bids/service.js';
import type { Logger } from '../logger.js';
import { extractContext, SpanKind, SpanStatusCode, withSpan } from '../telemetry.js';
import { toGrpcError } from './errors.js';

export const BID_SERVICE_NAME = 'bidstream.bid.v1.BidService';
export const IDEMPOTENT_REPLAY_HEADER = 'x-idempotent-replay';

/** Options mandated by docs/contracts.md for every TypeScript service. */
export const PROTO_LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
};

export function loadBidServiceDefinition(protoDir: string): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync('bidstream/bid/v1/bid.proto', {
    ...PROTO_LOADER_OPTIONS,
    includeDirs: [protoDir],
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    bidstream: { bid: { v1: { BidService: grpc.ServiceClientConstructor } } };
  };
  return loaded.bidstream.bid.v1.BidService.service;
}

interface UnaryResult<Res> {
  response: Res;
  metadata?: grpc.Metadata;
}

// Status codes that mean "the server failed" rather than "the caller asked for something wrong".
const SERVER_FAULTS = new Set([grpc.status.INTERNAL, grpc.status.UNAVAILABLE, grpc.status.UNKNOWN]);

/** Wraps a promise-based handler with tracing, structured logging and error mapping. */
function unary<Req, Res>(
  method: string,
  logger: Logger,
  handler: (request: Req) => Promise<UnaryResult<Res>>,
): grpc.handleUnaryCall<Req, Res> {
  const rpc = `${BID_SERVICE_NAME}/${method}`;
  return (call, callback) => {
    const started = performance.now();
    const parent = extractContext(call.metadata.getMap());
    void withSpan(
      rpc,
      {
        kind: SpanKind.SERVER,
        parent,
        attributes: { 'rpc.system': 'grpc', 'rpc.service': BID_SERVICE_NAME, 'rpc.method': method },
      },
      async (span) => {
        let code: grpc.status = grpc.status.OK;
        try {
          const { response, metadata } = await handler(call.request);
          if (metadata) call.sendMetadata(metadata);
          callback(null, response);
        } catch (err) {
          const grpcError = toGrpcError(err);
          code = grpcError.code;
          if (SERVER_FAULTS.has(code)) {
            span.recordException(err instanceof Error ? err : String(err));
            span.setStatus({ code: SpanStatusCode.ERROR });
            logger.error({ err, rpc }, 'rpc failed');
          }
          callback(grpcError);
        } finally {
          span.setAttribute('rpc.grpc.status_code', code);
          logger.info(
            { rpc, code: grpc.status[code], duration_ms: Math.round((performance.now() - started) * 10) / 10 },
            'rpc handled',
          );
        }
      },
    );
  };
}

export interface GrpcServer {
  /** Binds and starts serving; resolves with the bound port (useful when `port` is 0). */
  listen(port: number): Promise<number>;
  setServing(serving: boolean): void;
  shutdown(timeoutMs: number): Promise<void>;
}

export function createGrpcServer(opts: { bidService: BidService; protoDir: string; logger: Logger }): GrpcServer {
  const { bidService, logger } = opts;
  const server = new grpc.Server();

  server.addService(loadBidServiceDefinition(opts.protoDir), {
    SubmitBid: unary('SubmitBid', logger, async (request: Parameters<BidService['submitBid']>[0]) => {
      const { bid, replay } = await bidService.submitBid(request);
      if (!replay) return { response: bid };
      const metadata = new grpc.Metadata();
      metadata.set(IDEMPOTENT_REPLAY_HEADER, 'true');
      return { response: bid, metadata };
    }),
    GetBid: unary('GetBid', logger, async (request: Parameters<BidService['getBid']>[0]) => ({
      response: await bidService.getBid(request),
    })),
    ListBids: unary('ListBids', logger, async (request: Parameters<BidService['listBids']>[0]) => ({
      response: { bids: await bidService.listBids(request) },
    })),
  });

  // Starts NOT_SERVING; main flips it once migrations ran and consumers started.
  const health = new HealthImplementation({ '': 'NOT_SERVING', [BID_SERVICE_NAME]: 'NOT_SERVING' });
  health.addToServer(server);

  return {
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) =>
          err ? reject(err) : resolve(boundPort),
        );
      }),
    setServing: (serving) => {
      const value = serving ? 'SERVING' : 'NOT_SERVING';
      health.setStatus('', value);
      health.setStatus(BID_SERVICE_NAME, value);
    },
    shutdown: (timeoutMs) =>
      new Promise<void>((resolve) => {
        // Let in-flight calls finish; cut them off if they take too long.
        const timer = setTimeout(() => {
          logger.warn('grpc graceful shutdown timed out; forcing');
          server.forceShutdown();
          resolve();
        }, timeoutMs);
        server.tryShutdown(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}
