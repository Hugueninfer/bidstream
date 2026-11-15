# ADR 0003 — A database per service, read models from events

**Status:** accepted

## Context
Sharing tables between services couples their deploys and schemas. But
services still need each other's data: bid-service must know whether an RFQ is
open, rfq-service shows how many bids an RFQ has.

## Decision
Each service owns one Postgres database (`rfq`, `bid`, `pricing`) and nobody
else reads it. Data another service needs travels as events and is kept in a
local read model: bid-service keeps `rfq_view` from `rfq.events`; rfq-service
keeps `bid_count` and the best bid from `bid.events`; pricing-service appends
awards to its price history. The only synchronous cross-service read is award
validation (rfq-service → bid-service `GetBid`), where stale data is not
acceptable.

## Consequences
- Services deploy and fail independently.
- Read models are eventually consistent; the API surfaces this explicitly
  (`409 rfq_syncing`) instead of hiding it.
- Locally the three databases share one Postgres instance; in production they
  can be split without code changes.
