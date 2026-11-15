.PHONY: install build test typecheck run image

install:
	npm ci

build:
	npm run build

test:
	npm test

typecheck:
	npm run typecheck

run: build
	npm start

# Build context is the repo root so the image can copy proto/.
image:
	docker build -f Dockerfile -t bidstream-edge-gateway:dev ../..
