# Performance: SLOs, load tests and what they found

BidStream is load tested with [k6](https://k6.io/) against the Kubernetes
deployment (kind + Istio ambient, see the README). This page records the SLOs,
how to run the tests, and the problems the first rounds of testing uncovered.

## SLOs

Encoded as k6 thresholds in [`loadtest/bidstream.js`](../loadtest/bidstream.js),
so a run exits non-zero when one is breached and the same script can gate CI.

| Endpoint | Objective |
|---|---|
| `GET /v1/rfqs` (list, with price estimates) | p95 < 300 ms |
| `GET /v1/rfqs/:id` (detail, with price estimate) | p95 < 200 ms |
| `GET /v1/rfqs/:id/bids` | p95 < 200 ms |
| `POST /v1/rfqs/:id/bids` | p95 < 300 ms |
| All requests | error rate < 1% (a `409` for a bid racing `rfq.created` counts as expected) |

## Workload

Two scenarios at a **constant arrival rate**, so latency is measured under a
fixed load instead of the load backing off when the system slows down:

- **browse** — a buyer lists RFQs, opens one and lists its bids (3 requests);
- **bid** — a supplier submits a bid with an `Idempotency-Key`.

`setup()` creates 30 RFQs across 6 SKUs in a fresh tenant.

```bash
make loadtest                          # one run at the nominal rate
make loadtest-steps OUT=results/x      # nominal, 2x, overload, recovery
```

[`loadtest/steps.sh`](../loadtest/steps.sh) runs four 45 s stages and keeps a
k6 summary per stage. The last stage goes back to the nominal rate after the
overload, which is what shows whether the system recovers on its own.

| Stage | browse/s | bid/s | ≈ requests/s |
|---|---|---|---|
| nominal | 40 | 10 | 130 |
| 2x | 100 | 25 | 325 |
| overload | 200 | 50 | 650 |
| recovery | 40 | 10 | 130 |

## Findings

### 1. The load test itself was wrong (69% "errors")

The first run reported 69% failed requests, all `404`. k6 runs the init code
once per virtual user, and the tenant id was `load_${Date.now()}` at the top
level, so every VU got its own tenant and could not see the RFQs that `setup()`
had created in another one. Tenant isolation was working exactly as designed.
The tenant is now chosen in `setup()` and passed to every VU. After the fix:
0% errors and every SLO met at the nominal rate (p95 31–66 ms).

### 2. Connection pool leak: rfq-service locked up until restarted

Above the nominal rate, rfq-service started answering every call after exactly
2 s (the gateway's deadline) and **never recovered**, even with no traffic.
Kubernetes eventually restarted one replica because its gRPC health check timed
out.

How it was found:

- the logs showed `PoolTimeout: couldn't get a connection after 30 sec`;
- `pg_stat_activity` showed the stuck replica had **zero** connections to
  Postgres, and `/proc/net/tcp` inside the pod confirmed it: the pool believed
  all of its connections were checked out while none existed;
- a standalone script (bursts of 40 callers on a 4-connection pool, cancelled at
  random points, the way gRPC cancels handlers when a deadline expires)
  reproduced it every time on psycopg-pool 3.2.4 and 3.2.6, and never on 3.3.3.

Fix: psycopg-pool 3.3.3 in rfq-service and pricing-service, plus a regression
test ([`tests/integration/test_pool.py`](../services/rfq-service/tests/integration/test_pool.py))
that fails on the old version and passes on the new one.

Same environment, same stages, before and after the upgrade:

| Stage | Before (3.2.4): errors | After (3.3.3): errors |
|---|---|---|
| nominal | 0% | 0% |
| 2x | 70% | 22% |
| overload | 100% — rfq-service stuck | 48% |
| recovery | **100% — never came back** | **7% — recovered by itself** |

The fixed build still sheds load above its capacity, which is expected, but it
degrades and comes back instead of needing a human to restart it. The leak only
shows up when cancellations line up badly, which is why one load run is not
enough to catch it and the deterministic regression test is.

### 3. The ~170 req/s ceiling was Docker, not BidStream

Throughput stopped at about 170 req/s with p50 latency above 1.5 s while every
service used under 15% of a core. Traces put the time *before* the services
answered, and probing each hop under load isolated it:

| Path, under the 2x load | p50 | max |
|---|---|---|
| `localhost:9080` (Docker's userland `docker-proxy` → kind node) | 392 ms | 651 ms |
| kind node IP `:30080` directly | 2 ms | 15 ms |

Even `/healthz`, which calls nothing downstream, took up to 7 s through
`localhost`: the 1 s + 2 s + 4 s pattern of TCP SYN retransmissions. The load
targets now call the node IP directly; in production there is no `docker-proxy`.

### 4. Tracing every request buried the host

During the runs the host reached a load average of 29 on 12 cores, with the
in-memory Jaeger at 320% CPU and the kernel swapping. Restarting Jaeger alone
took free memory from 0.5 GB to 3.2 GB. The services now sample 10% of traces
(`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `traceSampleRatio` in the Helm
values). The sampling decision is made at the edge and followed by every hop,
so sampled traces stay complete.

### 5. Smaller fixes found along the way

- The Postgres readiness probe ran `pg_isready` without `-d`, so Postgres logged
  `database "bidstream" does not exist` every 5 s.
- `rpk cluster health` in the topic bootstrap job needs Redpanda's admin API,
  which the Service does not expose; the job now waits on the Kafka API.

## Limits of these numbers

Everything above ran on one laptop: three kind nodes, Istio, Prometheus,
Grafana, Jaeger and k6 itself sharing 12 cores and 16 GB of RAM with a desktop
session. That is enough to find bugs and compare two builds side by side, but
not to state BidStream's capacity in absolute terms: past the nominal stage the
host, not the services, is the bottleneck. Measuring absolute capacity is
planned for the public deployment on a dedicated VM (see the roadmap).
