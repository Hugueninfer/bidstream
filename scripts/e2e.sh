#!/usr/bin/env bash
# End-to-end smoke test against a running stack (docker compose up -d --build).
# Walks the whole story through the public API: create RFQ -> bid -> replay ->
# award, and checks the events and read models that tie the services together.
set -euo pipefail

API="${API:-http://localhost:8000}"
TENANT="e2e_$(date +%s)"
H=(-H "Content-Type: application/json" -H "X-Tenant-Id: $TENANT")

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
need() { command -v "$1" >/dev/null || fail "missing dependency: $1"; }
need curl; need jq

# retry <attempts> <cmd...>: eventual consistency means some reads lag behind writes.
retry() {
  local n=$1; shift
  for _ in $(seq "$n"); do "$@" && return 0; sleep 0.5; done
  return 1
}

echo "BidStream e2e against $API (tenant $TENANT)"

curl -fsS "$API/readyz" >/dev/null || fail "gateway not ready"
pass "gateway ready"

deadline=$(date -u -d '+3 days' +%Y-%m-%dT%H:%M:%SZ)
rfq=$(curl -fsS "${H[@]}" -X POST "$API/v1/rfqs" -d "{
  \"title\": \"E2E M8 bolts\", \"sku\": \"BOLT-M8\", \"quantity\": 40000,
  \"unit\": \"pcs\", \"deadline\": \"$deadline\"}")
rfq_id=$(jq -r .rfq_id <<<"$rfq")
[[ $rfq_id == rfq_* ]] || fail "create rfq: $rfq"
pass "created $rfq_id"

est=$(curl -fsS "$API/v1/estimate?sku=BOLT-M8&qty=40000")
jq -e '.low < .estimated_unit_price and .estimated_unit_price < .high' <<<"$est" >/dev/null \
  || fail "estimate band: $est"
pass "price estimate $(jq -r .estimated_unit_price <<<"$est") (band $(jq -r .low <<<"$est")–$(jq -r .high <<<"$est"))"

# bid-service learns about the RFQ from rfq.created; until then it answers 409 rfq_syncing.
submit_bid() {
  status=$(curl -sS -o /tmp/e2e_bid.json -w '%{http_code}' "${H[@]}" -H "Idempotency-Key: $1" \
    -X POST "$API/v1/rfqs/$rfq_id/bids" -d "$2")
  [[ $status == 201 || $status == 200 ]]
}
key=$(cat /proc/sys/kernel/random/uuid)
retry 20 submit_bid "$key" '{"supplier_name":"Kestrel Fastening Co.","unit_price":0.39,"lead_time_days":21}' \
  || fail "submit bid: $(cat /tmp/e2e_bid.json)"
bid_id=$(jq -r .bid_id /tmp/e2e_bid.json)
pass "bid $bid_id accepted once rfq.created reached bid-service"

submit_bid "$key" '{"supplier_name":"Kestrel Fastening Co.","unit_price":0.39,"lead_time_days":21}'
[[ $status == 200 && $(jq -r .bid_id /tmp/e2e_bid.json) == "$bid_id" ]] \
  || fail "idempotent replay returned $status $(cat /tmp/e2e_bid.json)"
pass "replay with same Idempotency-Key returned the same bid (200)"

submit_bid "$(cat /proc/sys/kernel/random/uuid)" '{"supplier_name":"Northgate Fasteners","unit_price":0.58,"lead_time_days":10}' \
  || fail "second bid"
count=$(curl -fsS "${H[@]}" "$API/v1/rfqs/$rfq_id/bids" | jq '.bids | length')
[[ $count == 2 ]] || fail "expected 2 bids, got $count"
pass "2 bids listed"

best_bid_projected() {
  curl -fsS "${H[@]}" "$API/v1/rfqs/$rfq_id" \
    | jq -e '.bid_count == 2 and .best_bid.unit_price == 0.39' >/dev/null
}
retry 20 best_bid_projected || fail "rfq-service read model never saw both bids"
pass "rfq-service projected bid_count=2, best bid 0.39 from bid.events"

awarded=$(curl -fsS "${H[@]}" -X POST "$API/v1/rfqs/$rfq_id/award" -d "{\"bid_id\":\"$bid_id\"}")
jq -e '.status == "awarded" and .awarded.unit_price == 0.39' <<<"$awarded" >/dev/null \
  || fail "award: $awarded"
pass "awarded to Kestrel"

status=$(curl -sS -o /tmp/e2e_bid.json -w '%{http_code}' "${H[@]}" -X POST "$API/v1/rfqs/$rfq_id/bids" \
  -d '{"supplier_name":"Late Supplier","unit_price":0.30,"lead_time_days":5}')
[[ $status == 409 && $(jq -r .error.code /tmp/e2e_bid.json) == rfq_closed ]] \
  || fail "late bid should be 409 rfq_closed, got $status $(cat /tmp/e2e_bid.json)"
pass "late bid rejected with 409 rfq_closed"

status=$(curl -sS -o /dev/null -w '%{http_code}' "${H[@]}" -X POST "$API/v1/rfqs" -d '{"title":"x"}')
[[ $status == 400 ]] || fail "invalid rfq should be 400, got $status"
pass "invalid input rejected with 400"

feed_has_award() {
  # The stream never ends on its own, so read for 2 s; curl's timeout exit is expected.
  local out
  out=$(curl -sS -N --max-time 2 "$API/v1/events?tenant_id=$TENANT" 2>/dev/null || true)
  grep -q '"event_type":"rfq.awarded"' <<<"$out"
}
retry 10 feed_has_award || fail "activity feed never showed rfq.awarded"
pass "activity feed (SSE) streamed rfq.awarded"

curl -fsS "$API/v1/health" | jq -e '[.services[] | select(.status == "down")] | length == 0' >/dev/null \
  || fail "a service reports down"
pass "all services healthy"

echo "All checks passed."
