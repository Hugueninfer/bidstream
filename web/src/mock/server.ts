// In-browser fake of edge-gateway for VITE_MOCK=1 (dev only). Implements the contract in docs/contracts.md.
import type {
  ActivityEvent,
  Bid,
  HealthResponse,
  PriceEstimate,
  Rfq,
  ServiceHealth,
} from "../api/types";
import { formatQuantity, formatUnitPrice } from "../lib/format";
import { RFQS, SCRIPTED_BIDS, SKUS, SUPPLIERS } from "./fixtures";

const TENANT = "tenant_demo";
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const round2 = (n: number) => Math.round(n * 100) / 100;

export type MockFlags = { pricingDown: boolean; empty: boolean; flakySse: boolean };

type RfqRow = Omit<Rfq, "bid_count" | "best_bid" | "estimate" | "estimate_error"> & { visibleAt: number };
type Reply = { status: number; body: unknown };

const err = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } });

export class MockBackend {
  private rfqs = new Map<string, RfqRow>();
  private bids = new Map<string, Bid[]>();
  private idem = new Map<string, Bid>();
  private cache = new Set<string>();
  private history: ActivityEvent[] = [];
  private listeners = new Set<(type: "activity" | "health", data: unknown) => void>();
  private started = false;

  constructor(readonly flags: MockFlags) {
    if (!flags.empty) this.seed();
  }

  // ---------- seed ----------

  private seed() {
    const now = Date.now();
    for (const f of RFQS) {
      const created = now - f.createdAgo;
      const deadline = now + f.deadlineIn;
      const sku = SKUS.find((s) => s.sku === f.sku)!;
      const bids: Bid[] = f.bids.map((b) => this.makeBid(f.id, b.supplier, b.price, b.lead, now - b.ago, b.id));
      const win = f.winner ? bids.find((b) => b.bid_id === f.winner) : undefined;
      const awardedAt = deadline - 60 * 60 * 1000;
      this.rfqs.set(f.id, {
        rfq_id: f.id,
        tenant_id: TENANT,
        title: f.title,
        sku: f.sku,
        quantity: f.quantity,
        unit: sku.unit,
        deadline: iso(deadline),
        status: f.status,
        created_at: iso(created),
        awarded: win
          ? { bid_id: win.bid_id, supplier_name: win.supplier_name, unit_price: win.unit_price, awarded_at: iso(awardedAt) }
          : null,
        visibleAt: now + (f.syncingFor ?? 0),
      });
      this.bids.set(f.id, bids);

      this.record(this.createdEvent(this.rfqs.get(f.id)!), false);
      for (const b of bids) this.record(this.bidEvent(b), false);
      if (win) this.record(this.awardedEvent(this.rfqs.get(f.id)!), false);
    }
    this.history.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  }

  private makeBid(rfqId: string, supplier: string, price: number, lead: number, at: number, id?: string): Bid {
    return {
      bid_id: id ?? `bid_${hex(12)}`,
      rfq_id: rfqId,
      supplier_id: `sup_${slug(supplier)}`,
      supplier_name: supplier,
      unit_price: price,
      currency: "USD",
      lead_time_days: lead,
      submitted_at: iso(at),
    };
  }

  // ---------- events ----------

  private ev(topic: string, type: string, key: string, at: string, summary: string, data: Record<string, unknown>): ActivityEvent {
    return { event_id: uuid(), topic, event_type: type, key, occurred_at: at, summary, data };
  }
  private createdEvent(r: RfqRow) {
    return this.ev("rfq.events", "rfq.created", r.rfq_id, r.created_at, `${r.sku} × ${formatQuantity(r.quantity)}`, {
      rfq_id: r.rfq_id, tenant_id: TENANT, title: r.title, sku: r.sku, quantity: r.quantity, unit: r.unit,
      deadline: r.deadline, created_at: r.created_at,
    });
  }
  private bidEvent(b: Bid) {
    return this.ev("bid.events", "bid.submitted", b.rfq_id, b.submitted_at, `${b.supplier_name} ${formatUnitPrice(b.unit_price)}`, {
      ...b, tenant_id: TENANT,
    });
  }
  private awardedEvent(r: RfqRow) {
    const a = r.awarded!;
    return this.ev("rfq.events", "rfq.awarded", r.rfq_id, a.awarded_at, `${a.supplier_name} ${formatUnitPrice(a.unit_price)}`, {
      rfq_id: r.rfq_id, tenant_id: TENANT, sku: r.sku, quantity: r.quantity, bid_id: a.bid_id,
      supplier_id: `sup_${slug(a.supplier_name)}`, supplier_name: a.supplier_name, unit_price: a.unit_price, awarded_at: a.awarded_at,
    });
  }

  /** Store an event and (optionally) push it to connected streams after an outbox-like delay. */
  private record(e: ActivityEvent, publish = true) {
    this.history.push(e);
    if (this.history.length > 500) this.history.shift();
    if (publish) window.setTimeout(() => this.emit("activity", e), rand(150, 450));
  }

  private emit(type: "activity" | "health", data: unknown) {
    for (const fn of this.listeners) fn(type, data);
  }

  subscribe(fn: (type: "activity" | "health", data: unknown) => void): { replay: ActivityEvent[]; unsubscribe: () => void } {
    this.listeners.add(fn);
    this.startSimulation();
    return { replay: this.history.slice(-50), unsubscribe: () => this.listeners.delete(fn) };
  }

  private startSimulation() {
    if (this.started) return;
    this.started = true;
    window.setInterval(() => this.emit("health", this.health()), 5000);
    if (this.flags.empty) return;
    for (const s of SCRIPTED_BIDS) {
      window.setTimeout(() => this.addBid(s.rfq, s.supplier, s.price, s.lead, s.id), s.after);
    }
    const loop = () => {
      window.setTimeout(() => {
        this.randomBid();
        loop();
      }, rand(18_000, 30_000));
    };
    window.setTimeout(loop, 15_000);
  }

  private randomBid() {
    const now = Date.now();
    const open = [...this.rfqs.values()].filter((r) => this.statusOf(r) === "open" && r.visibleAt <= now);
    const r = open[Math.floor(Math.random() * open.length)];
    if (!r) return;
    const est = this.estimateFor(r.sku, r.quantity);
    const supplier = SUPPLIERS[Math.floor(Math.random() * SUPPLIERS.length)]!;
    this.addBid(r.rfq_id, supplier, round2(est.estimated_unit_price * rand(0.84, 1.2)), Math.round(rand(3, 25)));
  }

  private addBid(rfqId: string, supplier: string, price: number, lead: number, id?: string): Bid | null {
    const r = this.rfqs.get(rfqId);
    if (!r || this.statusOf(r) !== "open") return null;
    const bid = this.makeBid(rfqId, supplier, price, lead, Date.now(), id);
    this.bids.get(rfqId)!.unshift(bid);
    this.record(this.bidEvent(bid));
    return bid;
  }

  // ---------- derived ----------

  private statusOf(r: RfqRow): Rfq["status"] {
    if (r.status === "open" && Date.parse(r.deadline) <= Date.now()) r.status = "expired";
    return r.status;
  }

  private estimateFor(sku: string, qty: number): PriceEstimate {
    const s = SKUS.find((x) => x.sku === sku)!;
    const est = s.anchor * Math.pow(qty / s.typical, -0.08);
    const key = `${sku}:${qty}`;
    const hit = this.cache.has(key);
    this.cache.add(key);
    return {
      sku,
      quantity: qty,
      estimated_unit_price: round2(est) || est,
      low: est * 0.894,
      high: est * 1.128,
      sample_size: s.samples,
      cache_hit: hit,
      model_version: "v1",
      latency_ms: Math.round(hit ? rand(8, 16) : rand(32, 61)),
    };
  }

  private toRfq(r: RfqRow): Rfq {
    const status = this.statusOf(r);
    const bids = this.bids.get(r.rfq_id) ?? [];
    const best = bids.reduce<Bid | null>((m, b) => (!m || b.unit_price < m.unit_price ? b : m), null);
    const { visibleAt: _v, ...rest } = r;
    void _v;
    return {
      ...rest,
      status,
      bid_count: bids.length,
      best_bid: best ? { unit_price: best.unit_price, supplier_name: best.supplier_name } : null,
      estimate: this.flags.pricingDown ? null : this.estimateFor(r.sku, r.quantity),
      estimate_error: this.flags.pricingDown ? { code: "pricing_unavailable", message: "timeout after 800 ms" } : null,
    };
  }

  health(): HealthResponse {
    const now = Date.now();
    const syncing = [...this.rfqs.values()].find((r) => r.visibleAt > now);
    const svc = (name: ServiceHealth["name"], p95: number): ServiceHealth => ({
      name,
      status: "healthy",
      p95_ms: Math.round(p95 * rand(0.9, 1.1)),
      detail: null,
    });
    const services = [svc("rfq-service", 42), svc("bid-service", 38), svc("pricing-service", 61)];
    if (syncing) {
      services[1] = { name: "bid-service", status: "degraded", p95_ms: 38, detail: `lagging · ${((syncing.visibleAt - now) / 1000).toFixed(1)} s` };
    }
    if (this.flags.pricingDown) services[2] = { name: "pricing-service", status: "down", p95_ms: null, detail: "3 timeouts" };
    return { services, checked_at: iso(now) };
  }

  // ---------- HTTP ----------

  handle(method: string, url: URL, headers: Headers, rawBody: string | null): Reply {
    const path = url.pathname;
    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return err(400, "validation_error", "body is not valid JSON");
      }
    }

    if (method === "GET" && path === "/v1/skus") return { status: 200, body: { skus: SKUS.map(({ sku, unit }) => ({ sku, unit })) } };
    if (method === "GET" && path === "/v1/health") return { status: 200, body: this.health() };

    if (method === "GET" && path === "/v1/estimate") {
      const sku = url.searchParams.get("sku") ?? "";
      const qty = Number(url.searchParams.get("qty"));
      if (!SKUS.some((s) => s.sku === sku)) return err(404, "not_found", `unknown SKU ${sku}`);
      if (!Number.isInteger(qty) || qty <= 0) return err(400, "validation_error", "qty must be a positive integer");
      if (this.flags.pricingDown) return err(503, "pricing_unavailable", "timeout after 800 ms");
      return { status: 200, body: this.estimateFor(sku, qty) };
    }

    if (path === "/v1/rfqs") {
      if (method === "GET") {
        const all = [...this.rfqs.values()].map((r) => this.toRfq(r));
        all.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        const status = url.searchParams.get("status");
        const counts = {
          all: all.length,
          open: all.filter((r) => r.status === "open").length,
          awarded: all.filter((r) => r.status === "awarded").length,
          expired: all.filter((r) => r.status === "expired").length,
        };
        return { status: 200, body: { rfqs: status ? all.filter((r) => r.status === status) : all, counts } };
      }
      if (method === "POST") return this.createRfq(body);
    }

    const m = path.match(/^\/v1\/rfqs\/([^/]+)(\/bids|\/award)?$/);
    if (m) {
      const r = this.rfqs.get(decodeURIComponent(m[1]!));
      if (!r) return err(404, "not_found", `RFQ ${m[1]} not found`);
      if (!m[2] && method === "GET") return { status: 200, body: this.toRfq(r) };
      if (m[2] === "/bids" && method === "GET") {
        const bids = [...(this.bids.get(r.rfq_id) ?? [])].sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));
        return { status: 200, body: { bids } };
      }
      if (m[2] === "/bids" && method === "POST") return this.submitBid(r, body, headers.get("Idempotency-Key"));
      if (m[2] === "/award" && method === "POST") return this.award(r, body);
    }
    return err(404, "not_found", `no route for ${method} ${path}`);
  }

  private createRfq(b: Record<string, unknown>): Reply {
    const { title, sku, quantity, unit, deadline } = b;
    if (typeof title !== "string" || !title.trim()) return err(400, "validation_error", "title is required");
    if (typeof sku !== "string" || !SKUS.some((s) => s.sku === sku)) return err(400, "validation_error", "unknown sku");
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0)
      return err(400, "validation_error", "quantity must be a positive integer");
    if (typeof unit !== "string" || !unit) return err(400, "validation_error", "unit is required");
    if (typeof deadline !== "string" || !(Date.parse(deadline) > Date.now()))
      return err(400, "validation_error", "deadline must be an RFC 3339 time in the future");
    const now = Date.now();
    const row: RfqRow = {
      rfq_id: `rfq_${hex(12)}`, tenant_id: TENANT, title: title.trim(), sku, quantity, unit, deadline,
      status: "open", created_at: iso(now), awarded: null, visibleAt: now + 4000,
    };
    this.rfqs.set(row.rfq_id, row);
    this.bids.set(row.rfq_id, []);
    this.record(this.createdEvent(row));
    return { status: 201, body: this.toRfq(row) };
  }

  private submitBid(r: RfqRow, b: Record<string, unknown>, key: string | null): Reply {
    if (key && this.idem.has(`${r.rfq_id}:${key}`)) return { status: 200, body: this.idem.get(`${r.rfq_id}:${key}`) };
    const name = typeof b.supplier_name === "string" ? b.supplier_name.trim() : "";
    const price = b.unit_price;
    const lead = b.lead_time_days;
    if (!name) return err(400, "validation_error", "supplier_name is required");
    if (typeof price !== "number" || !(price > 0)) return err(400, "validation_error", "unit_price must be > 0");
    if (typeof lead !== "number" || !Number.isInteger(lead) || lead < 1 || lead > 365)
      return err(400, "validation_error", "lead_time_days must be an integer between 1 and 365");
    const status = this.statusOf(r);
    if (status !== "open") return err(409, "rfq_closed", `RFQ ${r.rfq_id} is ${status}`);
    const lag = r.visibleAt - Date.now();
    if (lag > 0)
      return err(409, "rfq_syncing", `bid-service hasn't consumed rfq.created yet · projection lag ${(lag / 1000).toFixed(1)} s`);
    const bid = this.addBid(r.rfq_id, name, price, lead)!;
    if (key) this.idem.set(`${r.rfq_id}:${key}`, bid);
    return { status: 201, body: bid };
  }

  private award(r: RfqRow, b: Record<string, unknown>): Reply {
    const bid = (this.bids.get(r.rfq_id) ?? []).find((x) => x.bid_id === b.bid_id);
    if (!bid) return err(404, "not_found", `bid ${String(b.bid_id)} not found on ${r.rfq_id}`);
    const status = this.statusOf(r);
    if (status !== "open") return err(409, "rfq_closed", `RFQ ${r.rfq_id} is ${status}`);
    r.status = "awarded";
    r.awarded = { bid_id: bid.bid_id, supplier_name: bid.supplier_name, unit_price: bid.unit_price, awarded_at: iso(Date.now()) };
    this.record(this.awardedEvent(r));
    return { status: 200, body: this.toRfq(r) };
  }
}
