// Load test for the public API: buyers browsing RFQs and suppliers bidding,
// at a constant arrival rate so latency is measured under a fixed load.
//
//   k6 run loadtest/bidstream.js
//   BASE_URL=http://localhost:9080 READ_RATE=80 BID_RATE=15 DURATION=3m k6 run loadtest/bidstream.js
//
// Thresholds encode the SLOs from docs/performance.md; k6 exits non-zero when
// one is breached, so the same script works as a CI gate.
import http from "k6/http";
import { check, fail } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:9080";
const READ_RATE = Number(__ENV.READ_RATE || 40);
const BID_RATE = Number(__ENV.BID_RATE || 10);
const DURATION = __ENV.DURATION || "2m";
const RFQ_COUNT = Number(__ENV.RFQ_COUNT || 30);

const SKUS = [
  ["BOLT-M8", 40000, "pcs"],
  ["NUT-M8", 60000, "pcs"],
  ["STEEL-SHEET-2MM", 1200, "sheets"],
  ["PALLET-WOOD", 800, "pallets"],
  ["CARDBOARD-BOX-L", 15000, "boxes"],
  ["LUBRICANT-5L", 300, "cans"],
];

// Init code runs once per VU, so anything time-based (like the tenant) must be
// chosen in setup() and passed along, or every VU would get its own tenant.
const headersFor = (tenant) => ({ "Content-Type": "application/json", "X-Tenant-Id": tenant });

// A bid can race rfq.created reaching bid-service; 409 is an expected answer.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

export const options = {
  scenarios: {
    browse: {
      executor: "constant-arrival-rate",
      exec: "browse",
      rate: READ_RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
    bid: {
      executor: "constant-arrival-rate",
      exec: "bid",
      rate: BID_RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:list_rfqs}": ["p(95)<300"],
    "http_req_duration{name:get_rfq}": ["p(95)<200"],
    "http_req_duration{name:list_bids}": ["p(95)<200"],
    "http_req_duration{name:submit_bid}": ["p(95)<300"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  const tenant = __ENV.TENANT || `load_${Date.now()}`;
  const headers = headersFor(tenant);
  const deadline = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const rfqs = [];
  for (let i = 0; i < RFQ_COUNT; i++) {
    const [sku, quantity, unit] = SKUS[i % SKUS.length];
    const res = http.post(
      `${BASE_URL}/v1/rfqs`,
      JSON.stringify({ title: `Load test ${sku} #${i}`, sku, quantity, unit, deadline }),
      { headers, tags: { name: "create_rfq" } },
    );
    if (res.status !== 201) fail(`create rfq: ${res.status} ${res.body}`);
    rfqs.push(res.json());
  }
  return { tenant, rfqs };
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function browse({ tenant, rfqs }) {
  const headers = headersFor(tenant);
  const list = http.get(`${BASE_URL}/v1/rfqs`, { headers, tags: { name: "list_rfqs" } });
  check(list, { "list 200": (r) => r.status === 200 });

  const rfq = pick(rfqs);
  const detail = http.get(`${BASE_URL}/v1/rfqs/${rfq.rfq_id}`, { headers, tags: { name: "get_rfq" } });
  check(detail, { "detail 200": (r) => r.status === 200 });

  const bids = http.get(`${BASE_URL}/v1/rfqs/${rfq.rfq_id}/bids`, { headers, tags: { name: "list_bids" } });
  check(bids, { "bids 200": (r) => r.status === 200 });
}

export function bid({ tenant, rfqs }) {
  const rfq = pick(rfqs);
  const estimate = rfq.estimate ? rfq.estimate.estimated_unit_price : 1;
  const body = JSON.stringify({
    supplier_name: `Load Supplier ${__VU % 25}`,
    unit_price: Number((estimate * (0.85 + Math.random() * 0.3)).toFixed(4)),
    lead_time_days: 5 + Math.floor(Math.random() * 20),
  });
  const res = http.post(`${BASE_URL}/v1/rfqs/${rfq.rfq_id}/bids`, body, {
    headers: { ...headersFor(tenant), "Idempotency-Key": `${tenant}-${__VU}-${__ITER}` },
    tags: { name: "submit_bid" },
  });
  check(res, { "bid accepted": (r) => r.status === 201 || r.status === 200 });
}

export function handleSummary(data) {
  const out = { stdout: textSummary(data) };
  if (__ENV.SUMMARY_JSON) out[__ENV.SUMMARY_JSON] = JSON.stringify(data, null, 2);
  return out;
}

// Compact table: one line per endpoint with the latency percentiles the SLOs use.
function textSummary(data) {
  const rows = ["list_rfqs", "get_rfq", "list_bids", "submit_bid"].map((name) => {
    const m = data.metrics[`http_req_duration{name:${name}}`];
    if (!m) return `${name.padEnd(12)} (no data)`;
    const v = m.values;
    const fmt = (x) => `${x.toFixed(1).padStart(8)} ms`;
    return `${name.padEnd(12)} p50 ${fmt(v.med)}  p95 ${fmt(v["p(95)"])}  p99 ${fmt(v["p(99)"])}  max ${fmt(v.max)}`;
  });
  const reqs = data.metrics.http_reqs.values;
  const failed = data.metrics.http_req_failed.values.rate * 100;
  const breached = Object.entries(data.metrics)
    .filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok))
    .map(([name]) => name);
  return [
    "",
    `requests: ${reqs.count} (${reqs.rate.toFixed(1)}/s)  failed: ${failed.toFixed(2)}%`,
    ...rows,
    breached.length ? `SLO BREACHED: ${breached.join(", ")}` : "all SLOs met",
    "",
  ].join("\n");
}
