.PHONY: images up down infra logs e2e seed test k8s-up k8s-down k8s-e2e k8s-mesh-check k8s-canary loadtest loadtest-steps

# Builds use the host network: on some networks (e.g. phone hotspots with a
# small MTU) Docker's default bridge can't reach npm/PyPI. Override with
# `make images DOCKER_BUILD_FLAGS=` if you don't need it.
DOCKER_BUILD_FLAGS ?= --network=host
APPS := rfq-service bid-service pricing-service edge-gateway

images: ## Build every application image
	@for app in $(APPS); do \
	  docker build $(DOCKER_BUILD_FLAGS) -f services/$$app/Dockerfile -t bidstream/$$app:local . || exit 1; \
	done
	docker build $(DOCKER_BUILD_FLAGS) -f web/Dockerfile -t bidstream/web:local .

up: images ## Build and start the whole stack
	docker compose up -d

down: ## Stop the stack (keeps data)
	docker compose down

infra: ## Start only Postgres, Redis and Redpanda
	docker compose up -d postgres redis redpanda redpanda-init

logs:
	docker compose logs -f --tail=100

e2e: ## End-to-end smoke test against the running stack
	scripts/e2e.sh

seed: ## Load the demo story
	scripts/seed-demo.sh

test: ## Unit tests for every service and the web app
	$(MAKE) -C services/rfq-service test
	$(MAKE) -C services/pricing-service test
	$(MAKE) -C services/bid-service test
	$(MAKE) -C services/edge-gateway test
	cd web && npm test

# ---------- Kubernetes (kind + Istio ambient) ----------

k8s-up: images ## Local 3-node cluster with Istio and the whole app on :9080
	scripts/k8s-up.sh

k8s-down: ## Delete the local cluster
	kind delete cluster --name bidstream

k8s-e2e: ## End-to-end test through the Istio ingress
	API=http://localhost:9080 scripts/e2e.sh

k8s-mesh-check: ## Prove mTLS and authorization policies
	scripts/k8s-mesh-check.sh

WEIGHT ?= 10
k8s-canary: ## Send WEIGHT% of pricing traffic to model v2
	scripts/k8s-canary.sh $(WEIGHT)

# Load tests hit the kind node directly: Docker's userland proxy behind
# localhost:9080 tops out at ~170 req/s and would be what gets measured.
K8S_NODE_URL = http://$(shell docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' bidstream-control-plane 2>/dev/null):30080

loadtest: ## k6 load test against the cluster (see docs/performance.md)
	BASE_URL=$(K8S_NODE_URL) k6 run loadtest/bidstream.js

loadtest-steps: ## Nominal, 2x, overload and recovery stages; summaries in OUT
	BASE_URL=$(K8S_NODE_URL) loadtest/steps.sh $(or $(OUT),loadtest/results)
