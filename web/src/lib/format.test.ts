import { describe, expect, it } from "vitest";
import {
  dateTimeLocalToRfc3339,
  formatAgo,
  formatClock,
  formatCountdown,
  formatDateTime,
  formatDeadlineRelative,
  formatMoney,
  formatModel,
  formatQuantity,
  formatSignedPct,
  formatUnitPrice,
  isClosingSoon,
  shortId,
  toDateTimeLocalValue,
} from "./format";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe("money and numbers", () => {
  it("formats unit prices with exactly 2 decimals", () => {
    expect(formatUnitPrice(0.47)).toBe("$0.47");
    expect(formatUnitPrice(0.4)).toBe("$0.40");
    expect(formatUnitPrice(52.6)).toBe("$52.60");
    expect(formatUnitPrice(1240)).toBe("$1,240.00");
  });

  it("formats totals with thousands separators", () => {
    expect(formatMoney(18_800)).toBe("$18,800.00");
    expect(formatMoney(0.39 * 40_000)).toBe("$15,600.00");
    expect(formatMoney(1_234_567.891)).toBe("$1,234,567.89");
    expect(formatMoney(-3200)).toBe("−$3,200.00");
  });

  it("formats quantities", () => {
    expect(formatQuantity(40_000)).toBe("40,000");
    expect(formatQuantity(800)).toBe("800");
  });

  it("formats signed percentages with a typographic minus", () => {
    expect(formatSignedPct(-0.17)).toBe("−17.0%");
    expect(formatSignedPct(0.1385)).toBe("+13.9%");
    expect(formatSignedPct(0)).toBe("0.0%");
    expect(formatSignedPct(-0.0001)).toBe("0.0%");
  });

  it("prefixes model versions", () => {
    expect(formatModel("v1")).toBe("v1");
    expect(formatModel("1")).toBe("v1");
  });

  it("shortens rfq/bid ids to prefix + 4 hex", () => {
    expect(shortId("rfq_7f3a91c2b0de")).toBe("rfq_7f3a");
    expect(shortId("bid_9c41e2a7b5d0")).toBe("bid_9c41");
    expect(shortId("sup_kestrel_fastening_co")).toBe("sup_kestrel_fastening_co");
    expect(shortId("weird")).toBe("weird");
  });
});

describe("countdown", () => {
  it("shows days and a zero-padded clock", () => {
    expect(formatCountdown(2 * D + 2 * H + 50 * M + 21 * S)).toBe("2d 02:50:21");
  });
  it("drops the day part under a day", () => {
    expect(formatCountdown(5 * H + 3 * S)).toBe("05:00:03");
  });
  it("never goes negative", () => {
    expect(formatCountdown(-5000)).toBe("00:00:00");
  });
  it("floors partial seconds", () => {
    expect(formatCountdown(1999)).toBe("00:00:01");
  });
});

describe("relative times", () => {
  const now = new Date(2026, 10, 14, 14, 2, 30).getTime();

  it("formats future and past deadlines like the design", () => {
    expect(formatDeadlineRelative(new Date(2026, 10, 16, 17, 0), now)).toBe("in 2 days");
    expect(formatDeadlineRelative(new Date(2026, 10, 15, 8, 0), now)).toBe("in 18 hours");
    expect(formatDeadlineRelative(new Date(2026, 10, 17, 12, 0), now)).toBe("in 3 days");
    expect(formatDeadlineRelative(new Date(2026, 10, 12, 17, 0), now)).toBe("ended 2 days ago");
    expect(formatDeadlineRelative(new Date(2026, 10, 5, 17, 0), now)).toBe("ended 9 days ago");
    expect(formatDeadlineRelative(new Date(now + 45 * M), now)).toBe("in 45 minutes");
    expect(formatDeadlineRelative(new Date(now + 23 * H + 50 * M), now)).toBe("in 1 day");
  });

  it("flags deadlines under 24 h", () => {
    expect(isClosingSoon(new Date(now + 18 * H), now)).toBe(true);
    expect(isClosingSoon(new Date(now + 2 * D), now)).toBe(false);
    expect(isClosingSoon(new Date(now - H), now)).toBe(false);
  });

  it("formats bid ages", () => {
    expect(formatAgo(new Date(now - 2 * S), now)).toBe("just now");
    expect(formatAgo(new Date(now - 19 * S), now)).toBe("19 s ago");
    expect(formatAgo(new Date(now - 11 * M), now)).toBe("11 min ago");
    expect(formatAgo(new Date(now - 75 * M), now)).toBe("1 h 15 min ago");
    expect(formatAgo(new Date(now - 2 * H), now)).toBe("2 h ago");
    expect(formatAgo(new Date(now - 3 * D), now)).toBe("3 d ago");
    expect(formatAgo(new Date(now + 5 * S), now)).toBe("just now");
  });

  it("formats clock and date-time in local 24 h", () => {
    const d = new Date(2026, 10, 16, 17, 0, 5);
    expect(formatClock(d)).toBe("17:00:05");
    expect(formatDateTime(d)).toBe("Nov 16, 17:00");
  });
});

describe("datetime-local ⇄ RFC 3339", () => {
  it("round-trips a local time to UTC without millis", () => {
    const local = new Date(2026, 10, 21, 17, 0);
    const value = toDateTimeLocalValue(local);
    expect(value).toBe("2026-11-21T17:00");
    expect(dateTimeLocalToRfc3339(value)).toBe(local.toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(dateTimeLocalToRfc3339(value)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
  it("rejects garbage", () => {
    expect(dateTimeLocalToRfc3339("")).toBeNull();
    expect(dateTimeLocalToRfc3339("tomorrow")).toBeNull();
  });
});
