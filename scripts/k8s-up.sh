#!/usr/bin/env bash
# Creates a local 3-node Kubernetes cluster (kind) with Istio in ambient mode and
# deploys BidStream behind the Gateway API. Idempotent: re-running upgrades in place.
#
#   scripts/k8s-up.sh            cluster + mesh + app
#   ADDONS=0 scripts/k8s-up.sh   skip Prometheus/Grafana/Kiali/Jaeger
#
# App images must exist locally first (make images).
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=bidstream
ISTIO_VERSION=1.32.0
GATEWAY_API_VERSION=v1.7.0
NS=bidstream
ADDONS=${ADDONS:-1}
# Some networks (phone hotspots, VPNs) have a path MTU below 1500 and Docker
# doesn't clamp it, so pulls from inside the nodes hang. 1400 is safe everywhere.
export KIND_EXPERIMENTAL_DOCKER_NETWORK=bidstream-kind
KIND_MTU=${KIND_MTU:-1400}

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
for bin in docker kind kubectl helm istioctl curl jq; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }
done
fetch() { curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 "$@"; }

# Three kind nodes plus istio-cni/ztunnel exhaust the default inotify limits
# (128 instances) and the mesh pods crash with "too many open files".
if (( $(sysctl -n fs.inotify.max_user_instances) < 512 || $(sysctl -n fs.inotify.max_user_watches) < 524288 )); then
  echo "inotify limits too low for kind + Istio. Raise them with:" >&2
  echo "  sudo sysctl fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288" >&2
  exit 1
fi

step "Cluster"
if ! docker network inspect "$KIND_EXPERIMENTAL_DOCKER_NETWORK" >/dev/null 2>&1; then
  docker network create "$KIND_EXPERIMENTAL_DOCKER_NETWORK" \
    --opt com.docker.network.driver.mtu="$KIND_MTU" >/dev/null
fi
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --config deploy/kind/cluster.yaml --wait 120s
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

step "Images"
# Load what the host already has instead of pulling from inside the nodes.
images=(postgres:16-alpine redis:7-alpine redpandadata/redpanda:v24.2.4)
for image in "${images[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
done
for app in rfq-service bid-service pricing-service edge-gateway web; do
  image="bidstream/${app}:local"
  docker image inspect "$image" >/dev/null 2>&1 || { echo "missing $image, run: make images" >&2; exit 1; }
  images+=("$image")
done
kind load docker-image --name "$CLUSTER" "${images[@]}" >/dev/null

step "Gateway API CRDs ($GATEWAY_API_VERSION)"
fetch "https://github.com/kubernetes-sigs/gateway-api/releases/download/$GATEWAY_API_VERSION/standard-install.yaml" \
  | kubectl apply --server-side -f - >/dev/null

step "Istio $ISTIO_VERSION (ambient)"
if [[ $(istioctl version --remote=false --short 2>/dev/null) != "$ISTIO_VERSION"* ]]; then
  echo "warning: istioctl is not $ISTIO_VERSION" >&2
fi
istioctl install --set profile=ambient --skip-confirmation >/dev/null
kubectl -n istio-system rollout status ds/ztunnel --timeout=180s

if [[ $ADDONS == 1 ]]; then
  step "Observability addons (Prometheus, Grafana, Kiali, Jaeger)"
  for addon in prometheus grafana kiali jaeger; do
    fetch "https://raw.githubusercontent.com/istio/istio/release-${ISTIO_VERSION%.*}/samples/addons/$addon.yaml" \
      | kubectl apply -f - >/dev/null
  done
fi

step "BidStream"
kubectl apply -f deploy/istio/namespace.yaml >/dev/null
helm upgrade --install bidstream-data deploy/charts/bidstream-data -n "$NS" --wait --timeout 5m
kubectl apply -f deploy/istio/waypoint.yaml -f deploy/istio/security.yaml >/dev/null
values=()
# Keep the canary track on re-runs once it has been rolled out.
if kubectl -n "$NS" get deploy pricing-service-v2 >/dev/null 2>&1; then values=(-f deploy/values/canary.yaml); fi
helm upgrade --install bidstream deploy/charts/bidstream -n "$NS" "${values[@]}" --wait --timeout 5m
kubectl apply -f deploy/istio/gateway.yaml >/dev/null

step "Ingress on http://localhost:9080"
until kubectl -n "$NS" get svc bidstream-istio >/dev/null 2>&1; do sleep 2; done
port_index=$(kubectl -n "$NS" get svc bidstream-istio -o json | jq '.spec.ports | map(.port) | index(80)')
kubectl -n "$NS" patch svc bidstream-istio --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/ports/$port_index/nodePort\",\"value\":30080}]" >/dev/null
kubectl -n "$NS" wait --for=condition=programmed gateway/bidstream --timeout=120s >/dev/null
for _ in $(seq 60); do
  curl -fsS localhost:9080/readyz >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS localhost:9080/readyz && echo
echo "Done. App: http://localhost:9080  |  e2e: API=http://localhost:9080 scripts/e2e.sh"
