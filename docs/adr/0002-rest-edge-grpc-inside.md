# ADR 0002 — REST at the edge, gRPC inside

**Status:** accepted

## Context
The browser needs a simple, cacheable, debuggable API plus a live stream.
Service-to-service calls need strict contracts, low overhead and deadlines.

## Decision
A single `edge-gateway` (Backend-for-Frontend) exposes the public REST API
(`/v1`, OpenAPI at `/openapi.json`) and an SSE stream. Internally every
synchronous call is gRPC with versioned protos in `proto/`. The gateway owns
cross-cutting edge concerns: tenant resolution, CORS, error envelope, timeouts,
graceful degradation (a dead pricing-service yields `estimate: null`, not a
failed page) and the latency numbers behind `/v1/health`.

## Consequences
- One place to add auth, rate limiting and caching later.
- Two serialization formats to maintain; the proto→JSON mapping is unit tested.
- SSE was chosen over WebSockets: the stream is one-way, works through plain
  HTTP proxies, and `EventSource` reconnects on its own.
