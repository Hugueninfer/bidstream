#!/usr/bin/env bash
# Rolls out pricing-service model v2 as a canary and sets its traffic share.
#   scripts/k8s-canary.sh 10     10% of pricing calls to v2
#   scripts/k8s-canary.sh 100    promote: all traffic to v2
#   scripts/k8s-canary.sh 0      roll back: all traffic to v1
set -euo pipefail
cd "$(dirname "$0")/.."
WEIGHT=${1:-10}
[[ $WEIGHT =~ ^[0-9]+$ && $WEIGHT -le 100 ]] || { echo "usage: $0 <0-100>" >&2; exit 1; }

if ! kubectl -n bidstream get deploy pricing-service-v2 >/dev/null 2>&1; then
  helm upgrade bidstream deploy/charts/bidstream -n bidstream --reuse-values \
    -f deploy/values/canary.yaml --wait --timeout 3m
fi
sed -e "s/weight: 90 }/weight: $((100 - WEIGHT)) }/" -e "s/weight: 10 }/weight: $WEIGHT }/" \
  deploy/istio/canary.yaml | kubectl apply -f - >/dev/null
echo "pricing-service: v1 $((100 - WEIGHT))% / v2 ${WEIGHT}%"
sleep 5 # let istiod push the new weights to the waypoint before sampling

# Sample the split through the public API (estimates bypass the cache per quantity).
declare -A seen=([v1]=0 [v2]=0)
for i in $(seq 200); do
  v=$(curl -fsS "${API:-http://localhost:9080}/v1/estimate?sku=NUT-M8&qty=$((50000 + i))" | jq -r .model_version)
  seen[$v]=$(( ${seen[$v]:-0} + 1 ))
done
echo "observed over 200 calls: v1=${seen[v1]} v2=${seen[v2]}"
