#!/usr/bin/env bash
# Live smoke test against a bid-service attached to the compose network.
#   BID_ADDR=localhost:50062 services/bid-service/scripts/smoke.sh
# Publishes rfq.created with rpk, submits a bid, checks bid.events, replays.
set -euo pipefail
cd "$(dirname "$0")/.."

BID_ADDR="${BID_ADDR:-localhost:50062}"
REDPANDA="${REDPANDA_CONTAINER:-bidstream-redpanda-1}"
tenant="smoke_$(openssl rand -hex 4)"
rfq="rfq_$(openssl rand -hex 6)"
key="smoke-$(openssl rand -hex 4)"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deadline="$(date -u -d '+3 days' +%Y-%m-%dT%H:%M:%SZ)"
event_id="$(cat /proc/sys/kernel/random/uuid)"

envelope=$(cat <<JSON
{"event_id":"$event_id","event_type":"rfq.created","version":1,"occurred_at":"$now","tenant_id":"$tenant","key":"$rfq","data":{"rfq_id":"$rfq","tenant_id":"$tenant","title":"Smoke test M8 bolts","sku":"BOLT-M8","quantity":40000,"unit":"pcs","deadline":"$deadline","created_at":"$now"}}
JSON
)

echo "== produce rfq.created ($tenant / $rfq)"
echo "$envelope" | docker exec -i "$REDPANDA" rpk topic produce rfq.events -k "$rfq" -H event_type:rfq.created

echo "== SubmitBid (waiting for bid-service to consume rfq.created)"
for _ in $(seq 1 60); do
  if out=$(node scripts/submit-bid.mjs "$BID_ADDR" "$tenant" "$rfq" "Kestrel Fastening Co." 0.39 14 "$key"); then break; fi
  echo "   $out"; sleep 1
done
echo "$out"
bid_id=$(node -e 'console.log(JSON.parse(process.argv[1]).bid.bid_id)' "$out")

echo "== bid.submitted on bid.events"
sleep 1
# ":end" stops at the current end of every partition instead of waiting.
found=$(docker exec "$REDPANDA" rpk topic consume bid.events -o :end -f '%p@%o %h{%k=%v;}\t%v\n' | grep "$bid_id" || true)
[ -n "$found" ] || { echo "bid.submitted for $bid_id not found"; exit 1; }
echo "$found"

echo "== replay with the same idempotency key"
replay=$(node scripts/submit-bid.mjs "$BID_ADDR" "$tenant" "$rfq" "Kestrel Fastening Co." 0.39 14 "$key")
echo "$replay"
node -e '
  const a = JSON.parse(process.argv[1]), b = JSON.parse(process.argv[2]);
  if (!b.replay || a.bid.bid_id !== b.bid.bid_id) { console.error("replay check failed"); process.exit(1); }
  console.log("replay ok: same bid_id, x-idempotent-replay: true");
' "$out" "$replay"
