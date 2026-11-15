import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../api/types";
import {
  backoffDelay,
  initialLiveState,
  insertEvent,
  liveReducer,
  parseActivity,
  parseHealth,
} from "./eventReducer";

const ev = (id: string, at: string, type = "bid.submitted"): ActivityEvent => ({
  event_id: id,
  topic: type.startsWith("bid") ? "bid.events" : "rfq.events",
  event_type: type,
  key: "rfq_7f3a91c2b0de",
  occurred_at: at,
  summary: "Kestrel Fastening Co. $0.39",
  data: {},
});

describe("liveReducer", () => {
  it("keeps events newest first as they stream in oldest first", () => {
    let s = initialLiveState;
    s = liveReducer(s, { type: "activity", event: ev("a", "2026-11-14T13:00:00Z") });
    s = liveReducer(s, { type: "activity", event: ev("b", "2026-11-14T13:01:00Z") });
    s = liveReducer(s, { type: "activity", event: ev("c", "2026-11-14T13:02:00Z") });
    expect(s.events.map((e) => e.event_id)).toEqual(["c", "b", "a"]);
  });

  it("dedupes replayed events by event_id and returns the same state", () => {
    let s = liveReducer(initialLiveState, { type: "activity", event: ev("a", "2026-11-14T13:00:00Z") });
    const again = liveReducer(s, { type: "activity", event: ev("a", "2026-11-14T13:00:00Z") });
    expect(again).toBe(s);
    s = liveReducer(s, { type: "activity", event: ev("late", "2026-11-14T12:00:00Z") });
    expect(s.events.map((e) => e.event_id)).toEqual(["a", "late"]);
  });

  it("puts the latest arrival first among equal timestamps", () => {
    const t = "2026-11-14T13:00:00Z";
    const out = insertEvent(insertEvent([], ev("x", t)), ev("y", t));
    expect(out.map((e) => e.event_id)).toEqual(["y", "x"]);
  });

  it("caps the buffer", () => {
    let events: ActivityEvent[] = [];
    for (let i = 0; i < 10; i++) events = insertEvent(events, ev(`e${i}`, new Date(1e12 + i * 1000).toISOString()), 5);
    expect(events).toHaveLength(5);
    expect(events[0]!.event_id).toBe("e9");
  });

  it("tracks connection status and attempts", () => {
    let s = liveReducer(initialLiveState, { type: "error", retryAt: 123 });
    s = liveReducer(s, { type: "error", retryAt: 456 });
    expect(s).toMatchObject({ status: "reconnecting", attempt: 2, retryAt: 456 });
    s = liveReducer(s, { type: "open" });
    expect(s).toMatchObject({ status: "live", attempt: 0, retryAt: null });
  });

  it("stores the latest health snapshot", () => {
    const health = { services: [{ name: "rfq-service" as const, status: "healthy" as const, p95_ms: 42, detail: null }], checked_at: "t" };
    expect(liveReducer(initialLiveState, { type: "health", health }).health).toBe(health);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially with jitter and caps at 30 s", () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(30_000);
    expect(backoffDelay(20, () => 0)).toBe(15_000);
  });
});

describe("SSE payload parsing", () => {
  it("parses activity events and fills optional fields", () => {
    const e = parseActivity(JSON.stringify({ event_id: "1", event_type: "rfq.created", key: "rfq_1" }));
    expect(e).toMatchObject({ event_id: "1", event_type: "rfq.created", topic: "", summary: "", data: {} });
  });
  it("rejects malformed payloads", () => {
    expect(parseActivity("not json")).toBeNull();
    expect(parseActivity(JSON.stringify({ event_type: "x" }))).toBeNull();
    expect(parseHealth(JSON.stringify({ services: "nope" }))).toBeNull();
    expect(parseHealth(JSON.stringify({ services: [], checked_at: "t" }))).toEqual({ services: [], checked_at: "t" });
  });
});
