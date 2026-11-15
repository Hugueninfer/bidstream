# ADR 0004 — Redpanda as the Kafka implementation

**Status:** accepted

## Context
The event bus must speak the Kafka protocol (the industry default, and what
managed offerings such as Amazon MSK provide), but the whole stack also has to
run on a laptop and on a free 24 GB ARM VM.

## Decision
Use Redpanda: Kafka-API compatible, a single binary without ZooKeeper/KRaft
setup, and a small memory footprint. Services only use standard Kafka clients
(aiokafka, kafkajs), so swapping in Apache Kafka or MSK is a config change.

## Consequences
- Redpanda Console gives a free UI to inspect topics and the DLQs.
- Kafka-specific features beyond the protocol (e.g. Kafka Streams) are out of scope.
