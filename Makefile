.PHONY: images up down infra logs e2e seed test

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
