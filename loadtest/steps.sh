#!/usr/bin/env bash
# Runs the load test in fixed stages and keeps one k6 summary per stage, so two
# builds can be compared like for like (see docs/performance.md).
#
#   loadtest/steps.sh results/before
#
# The last stage goes back to the nominal load after an overload: it shows
# whether the system recovers by itself once the pressure is gone.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=${1:?usage: $0 <output-dir>}
DURATION=${DURATION:-45s}
mkdir -p "$OUT"

# Measure a healthy system or nothing: a stuck upstream would turn every stage into noise.
BASE_URL=${BASE_URL:-http://localhost:9080}
curl -fsS -m 5 -H "X-Tenant-Id: preflight" "$BASE_URL/v1/rfqs" >/dev/null \
  || { echo "API at $BASE_URL is not answering /v1/rfqs; fix that first" >&2; exit 1; }

#        name        reads/s bids/s
stages=("nominal     40      10"
        "2x          100     25"
        "overload    200     50"
        "recovery    40      10")

for stage in "${stages[@]}"; do
  read -r name reads bids <<<"$stage"
  echo "== $name: $reads browse + $bids bid iterations/s for $DURATION"
  READ_RATE=$reads BID_RATE=$bids DURATION=$DURATION SUMMARY_JSON="$OUT/$name.json" \
    k6 run -q loadtest/bidstream.js 2>/dev/null | sed -n '/^requests:/,/SLO\|all SLOs/p'
  [[ $name == overload ]] && sleep 30 # let in-flight work drain before measuring recovery
done
