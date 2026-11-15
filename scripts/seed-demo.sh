#!/usr/bin/env bash
# Fills a running stack with the demo story from the UI design: a handful of
# RFQs, competing supplier bids and one award. Uses only the public API, so
# every step also shows up in the System activity feed.
set -euo pipefail

API="${API:-http://localhost:8000}"
H=(-H "Content-Type: application/json" -H "X-Tenant-Id: ${TENANT:-tenant_demo}")

in_hours() { date -u -d "+$1 hours" +%Y-%m-%dT%H:%M:%SZ; }

create_rfq() { # title sku qty unit hours_until_deadline
  curl -fsS "${H[@]}" -X POST "$API/v1/rfqs" -d "$(jq -n \
    --arg t "$1" --arg s "$2" --argjson q "$3" --arg u "$4" --arg d "$(in_hours "$5")" \
    '{title:$t, sku:$s, quantity:$q, unit:$u, deadline:$d}')" | jq -r .rfq_id
}

bid() { # rfq_id supplier unit_price lead_time_days -> bid_id
  local body status
  body=$(jq -n --arg n "$2" --argjson p "$3" --argjson l "$4" \
    '{supplier_name:$n, unit_price:$p, lead_time_days:$l}')
  # The first bid on a new RFQ can race rfq.created reaching bid-service (409 rfq_syncing).
  for _ in $(seq 20); do
    status=$(curl -sS -o /tmp/seed_bid.json -w '%{http_code}' "${H[@]}" \
      -X POST "$API/v1/rfqs/$1/bids" -d "$body")
    [[ $status == 201 ]] && { jq -r .bid_id /tmp/seed_bid.json; return; }
    sleep 0.5
  done
  echo "bid failed ($status): $(cat /tmp/seed_bid.json)" >&2; return 1
}

bolts=$(create_rfq "M8 hex bolts, A2 stainless — Q1 restock" BOLT-M8 40000 pcs 50)
pallets=$(create_rfq "Wood pallets 1200×800 — warehouse B" PALLET-WOOD 800 pallets 18)
nuts=$(create_rfq "M8 nuts for assembly line 3" NUT-M8 60000 pcs 74)
steel=$(create_rfq "Cold-rolled steel sheet, 2 mm" STEEL-SHEET-2MM 1200 sheets 122)
lube=$(create_rfq "Machine lubricant 5 L — maintenance stock" LUBRICANT-5L 240 cans 30)

bid "$bolts" "Pelham & Roe Industrial" 0.44 12 >/dev/null
bid "$bolts" "Ironbark Supply" 0.47 9 >/dev/null
bid "$bolts" "Halvard Metalworks" 0.51 6 >/dev/null
bid "$bolts" "Northgate Fasteners" 0.58 10 >/dev/null
bid "$bolts" "Kestrel Fastening Co." 0.39 21 >/dev/null
bid "$pallets" "Ironbark Supply" 11.40 4 >/dev/null
bid "$nuts" "Kestrel Fastening Co." 0.12 14 >/dev/null
bid "$steel" "Brackwater Components" 52.60 18 >/dev/null
bid "$lube" "Halvard Metalworks" 34.90 7 >/dev/null
winner=$(bid "$lube" "Pelham & Roe Industrial" 31.50 5)

curl -fsS "${H[@]}" -X POST "$API/v1/rfqs/$lube/award" -d "{\"bid_id\":\"$winner\"}" >/dev/null

create_rfq "Shipping boxes, large — December peak" CARDBOARD-BOX-L 15000 boxes 146 >/dev/null

echo "Seeded demo data. Open http://localhost:3080"
