// VITE_MOCK=1 (dev only): patch fetch for /v1/* and replace EventSource with a fake stream.
// URL flags for demos/screenshots: ?pricing=down  ?empty=1  ?sse=flaky
import { MockBackend } from "./server";

export function installMocks() {
  const q = new URLSearchParams(window.location.search);
  const backend = new MockBackend({
    pricingDown: q.get("pricing") === "down",
    empty: q.get("empty") === "1",
    flakySse: q.get("sse") === "flaky",
  });

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (!url.pathname.startsWith("/v1/")) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === "string" ? init.body : null;
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 180));
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = backend.handle(method, url, headers, body);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  class MockEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 0;
    readonly withCredentials = false;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private unsubscribe: (() => void) | null = null;
    private timers: number[] = [];

    constructor(readonly url: string) {
      super();
      this.timers.push(
        window.setTimeout(() => {
          if (this.readyState === 2) return;
          this.readyState = 1;
          this.fire(new Event("open"));
          const sub = backend.subscribe((type, data) => this.send(type, data));
          this.unsubscribe = sub.unsubscribe;
          for (const e of sub.replay) this.send("activity", e);
          this.send("health", backend.health());
          if (backend.flags.flakySse) {
            this.timers.push(window.setTimeout(() => this.drop(), 20_000 + Math.random() * 10_000));
          }
        }, 250),
      );
    }

    private fire(e: Event) {
      this.dispatchEvent(e);
      if (e.type === "open") this.onopen?.(e);
      if (e.type === "error") this.onerror?.(e);
    }

    private send(type: string, data: unknown) {
      if (this.readyState !== 1) return;
      this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    }

    private drop() {
      if (this.readyState === 2) return;
      this.readyState = 0;
      this.unsubscribe?.();
      this.fire(new Event("error"));
    }

    close() {
      this.readyState = 2;
      this.unsubscribe?.();
      this.timers.forEach((t) => window.clearTimeout(t));
    }
  }

  window.EventSource = MockEventSource as unknown as typeof EventSource;
  console.info(
    "%cBidStream mock mode%c fixtures + fake /v1/events. Flags: ?pricing=down ?empty=1 ?sse=flaky",
    "font-weight:600;color:#4F46E5",
    "",
  );
}
