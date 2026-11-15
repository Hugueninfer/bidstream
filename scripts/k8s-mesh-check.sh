#!/usr/bin/env bash
# Proves the zero-trust setup on the running cluster:
#   1. every BidStream workload talks HBONE (mutual TLS through ztunnel);
#   2. a pod without an allowed identity is refused by Redis, the edge-gateway
#      and pricing-service (L7, at the waypoint, on every track Service), while
#      legitimate traffic flows.
set -euo pipefail
NS=bidstream
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

echo "Mesh check (namespace $NS)"

plain=$(istioctl ztunnel-config workloads --namespace "$NS" 2>/dev/null \
  | awk 'NR>1 && $1=="'"$NS"'" && $NF!="HBONE"' | grep -v -- '-istio-\|waypoint' || true)
[[ -z $plain ]] || fail "workloads outside the mesh:\n$plain"
pass "all workloads use HBONE (mTLS via ztunnel)"

# An "intruder" pod: same namespace, default service account, no policy allows it.
kubectl -n "$NS" delete pod intruder --ignore-not-found >/dev/null
kubectl -n "$NS" run intruder --image=redis:7-alpine --image-pull-policy=Never \
  --restart=Never --command -- sleep 600 >/dev/null
kubectl -n "$NS" wait --for=condition=Ready pod/intruder --timeout=60s >/dev/null
trap 'kubectl -n "$NS" delete pod intruder --ignore-not-found --wait=false >/dev/null' EXIT

if kubectl -n "$NS" exec intruder -- timeout 5 redis-cli -h redis ping 2>/dev/null | grep -q PONG; then
  fail "intruder reached Redis"
fi
pass "Redis refuses the intruder (only pricing-service may connect)"

if kubectl -n "$NS" exec intruder -- timeout 5 wget -qO- http://edge-gateway:8080/healthz >/dev/null 2>&1; then
  fail "intruder bypassed the ingress and reached edge-gateway"
fi
pass "edge-gateway refuses direct calls (only via the ingress gateway)"

# Expect an explicit 403 from the waypoint: any other failure would not prove the
# policy works. The per-track Services (canary targets) are side doors to the same
# pods, so they must refuse too.
tracks=$(kubectl -n "$NS" get svc -l app=pricing-service -o name | cut -d/ -f2)
for svc in $tracks; do
  status=$(kubectl -n "$NS" exec intruder -- timeout 5 wget -S -O /dev/null \
    "http://$svc:50063/bidstream.pricing.v1.PricingService/GetPriceEstimate" 2>&1 \
    | awk '/HTTP\//{print $2; exit}' || true) # wget exits non-zero on 403
  [[ $status == 403 ]] || fail "intruder got '${status:-no response}' from $svc instead of 403"
done
pass "pricing-service refuses the intruder at the waypoint (L7 policy): $(echo $tracks | tr ' ' ',')"

curl -fsS "${API:-http://localhost:9080}/v1/estimate?sku=BOLT-M8&qty=40000" >/dev/null \
  || fail "legitimate path ingress → edge-gateway → pricing-service is broken"
pass "legitimate traffic still flows (ingress → edge-gateway → waypoint → pricing-service)"
