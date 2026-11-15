# ADR 0001 — Publish events through a transactional outbox

**Status:** accepted

## Context
Services must change their database *and* tell the rest of the system about it.
Writing to Postgres and then publishing to Kafka in the request handler is a
dual write: if the process dies between the two, the database and the event
stream disagree forever (a bid exists that nobody heard about, or an event
announces a bid that was rolled back).

## Decision
Each service writes the business row and an `outbox` row in the **same
transaction**. A relay loop in the same process publishes unpublished outbox
rows to Kafka and marks them as published. Consumers record every handled
`event_id` in `processed_events` inside the transaction that applies the side
effect, so redelivery is harmless. Messages that keep failing go to
`<topic>.dlq` instead of blocking the partition.

## Consequences
- Delivery is at-least-once with effectively-once side effects.
- Events lag the write by the relay poll interval (~200 ms) — the UI must
  tolerate eventual consistency (see `rfq_syncing`).
- Polling adds light DB load; CDC (Debezium) would remove it but adds a
  component we don't need at this scale.
