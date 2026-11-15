import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityHub } from "../src/activity/hub.js";
import { activityEvent, makeApp } from "./fakes.js";

type SseMessage = { event?: string; id?: string; data?: string; comment?: string };

/** Minimal SSE client over a raw HTTP request, collecting parsed messages. */
function connect(url: string, headers: Record<string, string> = {}) {
  const messages: SseMessage[] = [];
  const waiters: Array<() => void> = [];
  let buffer = "";
  let response: http.IncomingMessage | undefined;

  const ready = new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      response = res;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const msg: SseMessage = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) msg.comment = line.slice(1).trim();
            else {
              const [field, ...rest] = line.split(": ");
              (msg as Record<string, string>)[field!] = rest.join(": ");
            }
          }
          messages.push(msg);
        }
        waiters.splice(0).forEach((w) => w());
      });
      resolve(res);
    });
    req.on("error", reject);
  });

  async function until(predicate: (m: SseMessage[]) => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(messages)) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(messages)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  return { messages, ready, until, close: () => response?.destroy() };
}

const activities = (m: SseMessage[]) =>
  m.filter((x) => x.event === "activity").map((x) => JSON.parse(x.data!).event_id as string);

describe("GET /v1/events (SSE)", () => {
  let close: () => Promise<void>;
  afterEach(() => close?.());

  async function start() {
    const made = await makeApp({ sse: { healthIntervalMs: 100, pingIntervalMs: 150 } });
    await made.app.listen({ host: "127.0.0.1", port: 0 });
    close = () => made.app.close();
    const { port } = made.app.server.address() as AddressInfo;
    return { ...made, base: `http://127.0.0.1:${port}` };
  }

  function seed(hub: ActivityHub, count: number, tenant = "tenant_demo") {
    for (let i = 1; i <= count; i++) hub.publish(tenant, activityEvent(i));
  }

  it("sends the last 50 events oldest first, then live events, health and pings", async () => {
    const { activity, base } = await start();
    seed(activity, 60);
    activity.publish("tenant_other", activityEvent(999, { event_id: "other-tenant" }));

    const client = connect(`${base}/v1/events?tenant_id=tenant_demo`, { origin: "http://localhost:5173" });
    const res = await client.ready;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["connection"]).toBe("keep-alive");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    await client.until((m) => activities(m).length >= 50);
    const backlog = activities(client.messages);
    expect(backlog).toHaveLength(50);
    expect(backlog[0]).toBe("evt-11");
    expect(backlog[49]).toBe("evt-60");

    activity.publish("tenant_demo", activityEvent(61));
    activity.publish("tenant_other", activityEvent(62, { event_id: "other-live" }));
    await client.until((m) => activities(m).includes("evt-61"));
    expect(activities(client.messages)).not.toContain("other-live");
    expect(activities(client.messages)).not.toContain("other-tenant");

    const live = client.messages.find((m) => m.id === "evt-61")!;
    expect(JSON.parse(live.data!)).toMatchObject({ event_id: "evt-61", summary: "BOLT-M8 × 61" });

    await client.until((m) => m.filter((x) => x.event === "health").length >= 2 && m.some((x) => x.comment === "ping"));
    const health = JSON.parse(client.messages.find((m) => m.event === "health")!.data!);
    expect(health.services).toHaveLength(3);
    client.close();
  });

  it("defaults to tenant_demo and resumes after Last-Event-ID", async () => {
    const { activity, base } = await start();
    seed(activity, 5);
    const client = connect(`${base}/v1/events`, { "last-event-id": "evt-3" });
    await client.until((m) => m.some((x) => x.event === "health"));
    expect(activities(client.messages)).toEqual(["evt-4", "evt-5"]);
    client.close();
  });

  it("unsubscribes when the client disconnects", async () => {
    const { activity, base } = await start();
    const client = connect(`${base}/v1/events`);
    await client.ready;
    await client.until((m) => m.some((x) => x.event === "health"));
    expect(activity.subscriberCount("tenant_demo")).toBe(1);
    client.close();
    const deadline = Date.now() + 2000;
    while (activity.subscriberCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(activity.subscriberCount()).toBe(0);
  });

  it("ends open streams on shutdown instead of hanging app.close()", async () => {
    const { app, activity, base } = await start();
    const client = connect(`${base}/v1/events`);
    const res = await client.ready;
    const ended = new Promise<void>((resolve) => res.on("end", () => resolve()));
    await client.until((m) => m.some((x) => x.event === "health"));
    await app.close();
    await ended;
    expect(activity.subscriberCount()).toBe(0);
  });
});
