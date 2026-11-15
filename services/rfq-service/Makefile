# Run from services/rfq-service. Everything runs in Docker (Python 3.12).
ROOT       := $(abspath ../..)
DOCKERFILE := $(ROOT)/services/rfq-service/Dockerfile
IMAGE      ?= bidstream-rfq-service
NETWORK    ?= bidstream_default
TEST_DB    ?= postgresql://bidstream:bidstream@postgres:5432/rfq
RFQ_ADDR   ?= rfq-service:50061
# Host networking for `pip install` during builds: on this machine TLS from the
# default bridge network times out. Override with BUILD_FLAGS= if yours is fine.
BUILD_FLAGS ?= --network=host

.PHONY: build test-image test test-integration lint smoke

build: ## Runtime image
	docker build $(BUILD_FLAGS) -f $(DOCKERFILE) -t $(IMAGE):dev $(ROOT)

test-image:
	docker build $(BUILD_FLAGS) -f $(DOCKERFILE) --target test -t $(IMAGE):test $(ROOT)

test: test-image ## Unit tests (no infrastructure needed)
	docker run --rm $(IMAGE):test pytest -m "not integration"

test-integration: test-image ## Integration tests against the compose Postgres
	docker run --rm --network $(NETWORK) -e DATABASE_URL=$(TEST_DB) \
	  $(IMAGE):test pytest -m integration

lint: test-image ## ruff lint + format check
	docker run --rm $(IMAGE):test sh -c "ruff check src tests scripts && ruff format --check src tests scripts"

smoke: test-image ## gRPC smoke test against a running rfq-service (RFQ_ADDR)
	docker run --rm --network $(NETWORK) -e RFQ_ADDR=$(RFQ_ADDR) \
	  $(IMAGE):test python scripts/smoke.py
