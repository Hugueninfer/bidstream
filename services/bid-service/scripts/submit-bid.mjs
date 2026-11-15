#!/usr/bin/env node
// Dev helper: SubmitBid against a running bid-service and print the result.
//   node scripts/submit-bid.mjs <addr> <tenant_id> <rfq_id> <supplier_name> <unit_price> <lead_time_days> [idempotency_key]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const [addr, tenant_id, rfq_id, supplier_name, unit_price, lead_time_days, idempotency_key = ''] = process.argv.slice(2);
if (!lead_time_days) {
  console.error('usage: submit-bid.mjs <addr> <tenant_id> <rfq_id> <supplier_name> <unit_price> <lead_time_days> [idempotency_key]');
  process.exit(2);
}

const protoDir = process.env.PROTO_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../proto');
const definition = protoLoader.loadSync('bidstream/bid/v1/bid.proto', {
  keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true, includeDirs: [protoDir],
});
const { BidService } = grpc.loadPackageDefinition(definition).bidstream.bid.v1;
const client = new BidService(addr, grpc.credentials.createInsecure());

const request = {
  tenant_id, rfq_id, supplier_name, unit_price: Number(unit_price), lead_time_days: Number(lead_time_days), idempotency_key,
};
let replay = false;
const call = client.SubmitBid(request, { deadline: Date.now() + 5_000 }, (err, bid) => {
  client.close();
  if (err) {
    console.log(JSON.stringify({ error: grpc.status[err.code], details: err.details }));
    process.exit(1);
  }
  console.log(JSON.stringify({ replay, bid }));
});
call.on('metadata', (md) => { replay = md.get('x-idempotent-replay')[0] === 'true'; });
