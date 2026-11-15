.PHONY: install build typecheck test test-integration image clean

IMAGE ?= bidstream-bid-service:dev
# e.g. DOCKER_BUILD_FLAGS=--network=host when the bridge network cannot reach npm.
DOCKER_BUILD_FLAGS ?=
REPO_ROOT := $(abspath ../..)

install:
	npm ci

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

# Needs the compose Postgres on localhost:55432 (or DATABASE_URL).
test-integration:
	npm run test:integration

# Build context is the repo root so the image can copy proto/.
image:
	docker build $(DOCKER_BUILD_FLAGS) -f $(REPO_ROOT)/services/bid-service/Dockerfile -t $(IMAGE) $(REPO_ROOT)

clean:
	rm -rf dist
