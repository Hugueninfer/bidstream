import { randomBytes } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { pino } from 'pino';
import { defaultMigrationsDir, findProtoDir } from '../../src/config.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { PROTO_LOADER_OPTIONS } from '../../src/grpc/server.js';

export const silentLogger = pino({ level: 'silent' });

export async function setupDatabase(): Promise<Pool> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for integration tests');
  const pool = createPool(url, silentLogger);
  await migrate(pool, defaultMigrationsDir, silentLogger);
  return pool;
}

/** A tenant nobody else uses, so tests can run against a shared database. */
export function uniqueTenant(): string {
  return `tenant_it_${randomBytes(4).toString('hex')}`;
}

export function rfqId(): string {
  return `rfq_${randomBytes(6).toString('hex')}`;
}

export async function seedRfq(
  pool: Pool,
  args: { tenantId: string; rfqId: string; status?: 'open' | 'awarded'; deadline?: Date; quantity?: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO rfq_view (rfq_id, tenant_id, status, deadline, quantity) VALUES ($1, $2, $3, $4, $5)`,
    [
      args.rfqId,
      args.tenantId,
      args.status ?? 'open',
      args.deadline ?? new Date(Date.now() + 86_400_000),
      args.quantity ?? 1_000,
    ],
  );
}

export async function cleanupTenant(pool: Pool, tenantId: string, eventIds: string[] = []): Promise<void> {
  await pool.query('DELETE FROM bids WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM rfq_view WHERE tenant_id = $1', [tenantId]);
  await pool.query(`DELETE FROM outbox WHERE payload->>'tenant_id' = $1`, [tenantId]);
  if (eventIds.length > 0) {
    await pool.query('DELETE FROM processed_events WHERE event_id = ANY($1::uuid[])', [eventIds]);
  }
}

// --- gRPC client ---

export interface Bid {
  bid_id: string;
  tenant_id: string;
  rfq_id: string;
  supplier_id: string;
  supplier_name: string;
  unit_price: number;
  currency: string;
  lead_time_days: number;
  submitted_at: string;
}

type Callback<T> = (err: grpc.ServiceError | null, response: T) => void;

interface BidServiceClient extends grpc.Client {
  SubmitBid(request: object, callback: Callback<Bid>): grpc.ClientUnaryCall;
  GetBid(request: object, callback: Callback<Bid>): grpc.ClientUnaryCall;
  ListBids(request: object, callback: Callback<{ bids: Bid[] }>): grpc.ClientUnaryCall;
}

export interface CallResult<T> {
  response: T;
  metadata: grpc.Metadata;
}

export function createClient(port: number): BidServiceClient {
  const definition = protoLoader.loadSync('bidstream/bid/v1/bid.proto', {
    ...PROTO_LOADER_OPTIONS,
    includeDirs: [findProtoDir()],
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    bidstream: { bid: { v1: { BidService: new (addr: string, creds: grpc.ChannelCredentials) => BidServiceClient } } };
  };
  return new loaded.bidstream.bid.v1.BidService(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}

/** Calls a unary method and also captures the response's initial metadata. */
export function call<T>(
  invoke: (callback: Callback<T>) => grpc.ClientUnaryCall,
): Promise<CallResult<T>> {
  return new Promise((resolve, reject) => {
    let metadata = new grpc.Metadata();
    const unaryCall = invoke((err, response) => (err ? reject(err) : resolve({ response, metadata })));
    unaryCall.on('metadata', (md: grpc.Metadata) => {
      metadata = md;
    });
  });
}
