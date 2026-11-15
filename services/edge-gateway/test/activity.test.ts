import kafkajs from "kafkajs";
import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { ActivityBuffer } from "../src/activity/buffer.js";
import { ActivityConsumer } from "../src/activity/consumer.js";
import { ActivityHub } from "../src/activity/hub.js";
import { buildSummary, parseEnvelope, toActivityEvent } from "../src/activity/summary.js";
import { activityEvent } from "./fakes.js";

const ids = (events: { event_id: string }[]) => events.map((e) => e.event_id);

describe("ActivityBuffer", () => {
  it("keeps the newest events up to capacity, oldest first", () => {
    const buf = new ActivityBuffer(3);
    for (let i = 1; i <= 5; i++) buf.add(activityEvent(i));
    expect(buf.size).toBe(3);
    expect(ids(buf.latest(10))).toEqual(["evt-3", "evt-4", "evt-5"]);
    expect(ids(buf.latest(2))).toEqual(["evt-4", "evt-5"]);
    expect(buf.latest(0)).toEqual([]);
  });

  it("ignores duplicate deliveries", () => {
    const buf = new ActivityBuffer(3);
    expect(buf.add(activityEvent(1))).toBe(true);
    expect(buf.add(activityEvent(1))).toBe(false);
    expect(buf.size).toBe(1);
  });

  it("orders interleaved topics by occurred_at", () => {
    const buf = new ActivityBuffer(10);
    for (const n of [1, 4, 2, 5, 3]) buf.add(activityEvent(n));
    expect(ids(buf.latest(10))).toEqual(["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"]);
  });

  it("drops late events older than a full buffer", () => {
    const buf = new ActivityBuffer(2);
    buf.add(activityEvent(5));
    buf.add(activityEvent(6));
    expect(buf.add(activityEvent(1))).toBe(false);
    expect(ids(buf.latest(2))).toEqual(["evt-5", "evt-6"]);
    // An evicted id may come back only if it is newer than what is kept.
    buf.add(activityEvent(7));
    expect(ids(buf.latest(2))).toEqual(["evt-6", "evt-7"]);
  });

  it("returns events after a given id for resume", () => {
    const buf = new ActivityBuffer(5);
    for (let i = 1; i <= 4; i++) buf.add(activityEvent(i));
    expect(ids(buf.after("evt-2")!)).toEqual(["evt-3", "evt-4"]);
    expect(buf.after("evt-4")).toEqual([]);
    expect(buf.after("nope")).toBeNull();
  });
});

describe("buildSummary", () => {
  it("formats bids and awards as supplier and price", () => {
    expect(buildSummary("bid.submitted", { supplier_name: "Kestrel Fastening Co.", unit_price: 0.39 })).toBe(
      "Kestrel Fastening Co. $0.39",
    );
    expect(buildSummary("bid.submitted", { supplier_name: "Acme", unit_price: 46.2 })).toBe("Acme $46.20");
    expect(buildSummary("rfq.awarded", { supplier_name: "Acme", unit_price: 12.1 })).toBe("Acme $12.10");
  });

  it("formats new RFQs as SKU × quantity with thousands separators", () => {
    expect(buildSummary("rfq.created", { sku: "CARDBOARD-BOX-L", quantity: 15000 })).toBe("CARDBOARD-BOX-L × 15,000");
    expect(buildSummary("rfq.created", { sku: "BOLT-M8", quantity: 1234567 })).toBe("BOLT-M8 × 1,234,567");
  });

  it("returns null for event types the feed does not know", () => {
    expect(buildSummary("rfq.cancelled", {})).toBeNull();
  });
});

const envelope = (overrides: Record<string, unknown> = {}) => ({
  event_id: "8a1f5c6e-0000-4000-8000-000000000001",
  event_type: "rfq.created",
  version: 1,
  occurred_at: "2026-11-14T14:02:11Z",
  tenant_id: "tenant_demo",
  key: "rfq_7f3a91c2b0de",
  data: { rfq_id: "rfq_7f3a91c2b0de", sku: "BOLT-M8", quantity: 40000 },
  ...overrides,
});

describe("parseEnvelope / toActivityEvent", () => {
  it("builds an ActivityEvent from a valid envelope", () => {
    const env = parseEnvelope(Buffer.from(JSON.stringify(envelope())));
    expect(toActivityEvent("rfq.events", env)).toEqual({
      event_id: "8a1f5c6e-0000-4000-8000-000000000001",
      topic: "rfq.events",
      event_type: "rfq.created",
      key: "rfq_7f3a91c2b0de",
      occurred_at: "2026-11-14T14:02:11Z",
      summary: "BOLT-M8 × 40,000",
      data: { rfq_id: "rfq_7f3a91c2b0de", sku: "BOLT-M8", quantity: 40000 },
    });
  });

  it.each([
    ["null", null],
    ["not json", Buffer.from("{oops")],
    ["array", Buffer.from("[]")],
    ["missing event_id", Buffer.from(JSON.stringify(envelope({ event_id: undefined })))],
    ["bad timestamp", Buffer.from(JSON.stringify(envelope({ occurred_at: "yesterday" })))],
    ["data not object", Buffer.from(JSON.stringify(envelope({ data: "x" })))],
  ])("rejects %s", (_name, value) => {
    expect(() => parseEnvelope(value)).toThrow();
  });
});

describe("ActivityHub", () => {
  it("isolates tenants and fans out to subscribers", () => {
    const hub = new ActivityHub();
    const seen: string[] = [];
    const unsubscribe = hub.subscribe("t1", (e) => seen.push(e.event_id));
    hub.publish("t1", activityEvent(1));
    hub.publish("t2", activityEvent(2));
    hub.publish("t1", activityEvent(1)); // duplicate: not re-broadcast
    unsubscribe();
    hub.publish("t1", activityEvent(3));
    expect(seen).toEqual(["evt-1"]);
    expect(ids(hub.recent("t1", 50))).toEqual(["evt-1", "evt-3"]);
    expect(ids(hub.recent("t2", 50))).toEqual(["evt-2"]);
    expect(hub.recent("nobody", 50)).toEqual([]);
    expect(hub.subscriberCount()).toBe(0);
  });
});

describe("ActivityConsumer.handle", () => {
  const logger = pino({ level: "silent" });

  it("publishes valid events to the tenant and ignores malformed ones (logging once)", async () => {
    const hub = new ActivityHub();
    const consumer = new ActivityConsumer(["localhost:1"], hub, logger);
    const warn = vi.spyOn(logger, "warn");
    const msg = (value: string | null) => ({
      topic: "bid.events",
      message: { key: Buffer.from("rfq_1"), value: value === null ? null : Buffer.from(value), headers: {}, offset: "0", timestamp: "0", attributes: 0 },
    });

    await consumer.handle(
      msg(
        JSON.stringify(
          envelope({
            event_type: "bid.submitted",
            data: { supplier_name: "Kestrel Fastening Co.", unit_price: 0.39 },
          }),
        ),
      ),
    );
    await consumer.handle(msg("garbage"));
    await consumer.handle(msg(null));
    await consumer.handle(msg(JSON.stringify(envelope({ event_id: "x2", event_type: "rfq.unknown" }))));

    expect(hub.recent("tenant_demo", 50).map((e) => e.summary)).toEqual(["Kestrel Fastening Co. $0.39"]);
    expect(consumer.malformedCount).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("kafka codecs", () => {
  it("registers snappy (rpk's default compression) and round-trips a payload", async () => {
    const factory = kafkajs.CompressionCodecs[kafkajs.CompressionTypes.Snappy];
    const codec = factory();
    const payload = Buffer.from(JSON.stringify(envelope()).repeat(5));
    const compressed = await codec.compress({ buffer: payload });
    expect(Buffer.from(await codec.decompress(compressed)).equals(payload)).toBe(true);
  });
});
