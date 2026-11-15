# Run from services/pricing-service. Builds use the repo root as context.
ROOT     := ../..
IMAGE    ?= bidstream-pricing-service:dev
TEST_IMG ?= bidstream-pricing-service:test
NETWORK  ?= bidstream_default
# Extra `docker build` flags, e.g. BUILD_FLAGS=--network=host when the default
# bridge network can't reach PyPI (MTU problems).
BUILD_FLAGS ?=

.PHONY: build test test-integration run smoke lint

build:
	docker build $(BUILD_FLAGS) -f Dockerfile -t $(IMAGE) $(ROOT)

test:
	docker build $(BUILD_FLAGS) -f Dockerfile --target test -t $(TEST_IMG) $(ROOT)
	docker run --rm $(TEST_IMG) pytest -m "not integration"

# Needs the infra from docker compose (postgres, redis) running.
# Uses its own throwaway database (pricing_test) and Redis DB 15.
test-integration:
	docker build $(BUILD_FLAGS) -f Dockerfile --target test -t $(TEST_IMG) $(ROOT)
	docker run --rm --network $(NETWORK) \
	  -e TEST_POSTGRES_URL=postgresql://bidstream:bidstream@postgres:5432/postgres \
	  -e TEST_REDIS_URL=redis://redis:6379/15 \
	  $(TEST_IMG) pytest -m integration

# Run the service against the compose infra (foreground; Ctrl-C to stop).
run: build
	docker run --rm --name pricing-service-dev --network $(NETWORK) \
	  -e DATABASE_URL=postgresql://bidstream:bidstream@postgres:5432/pricing \
	  -e REDIS_URL=redis://redis:6379/0 -e KAFKA_BROKERS=redpanda:9092 \
	  -e GRPC_PORT=50063 $(IMAGE)

# Call GetPriceEstimate on a running instance: make smoke ADDR=pricing-service-dev:50063
ADDR ?= pricing-service:50063
smoke:
	docker run --rm --network $(NETWORK) -v $(CURDIR)/scripts:/scripts:ro $(IMAGE) \
	  python /scripts/smoke.py $(ADDR)

lint:
	docker run --rm -v $(CURDIR):/src:ro -w /src -e RUFF_CACHE_DIR=/tmp/ruff python:3.12-slim \
	  sh -c 'pip install -q ruff==0.11.6 && ruff check src tests scripts && ruff format --check src tests scripts'
