#!/usr/bin/env bash
# Creates the event topics once. Safe to re-run.
set -euo pipefail
BROKERS="${KAFKA_BROKERS:-redpanda:9092}"
for topic in rfq.events bid.events; do
  rpk topic create "$topic" -p 3 -r 1 -X brokers="$BROKERS" || true
  rpk topic create "$topic.dlq" -p 1 -r 1 -X brokers="$BROKERS" || true
done
rpk topic list -X brokers="$BROKERS"
