import type { ActivityEvent, HealthResponse } from "../api/types";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export type LiveState = {
  status: ConnectionStatus;
  /** Newest first, deduplicated by event_id, capped at MAX_EVENTS. */
  events: ActivityEvent[];
  health: HealthResponse | null;
  /** Consecutive failed attempts (drives backoff). */
  attempt: number;
  /** When the next reconnect attempt is scheduled (epoch ms), while reconnecting. */
  retryAt: number | null;
};

export type LiveAction =
  | { type: "open" }
  | { type: "error"; retryAt: number }
  | { type: "activity"; event: ActivityEvent }
  | { type: "health"; health: HealthResponse };

export const MAX_EVENTS = 200;

export const initialLiveState: LiveState = {
  status: "connecting",
  events: [],
  health: null,
  attempt: 0,
  retryAt: null,
};

const ts = (e: ActivityEvent) => {
  const t = Date.parse(e.occurred_at);
  return Number.isNaN(t) ? 0 : t;
};

/** Insert keeping newest-first order; events with equal timestamps keep arrival order (later arrival first). */
export function insertEvent(events: ActivityEvent[], ev: ActivityEvent, max = MAX_EVENTS): ActivityEvent[] {
  if (events.some((e) => e.event_id === ev.event_id)) return events;
  const t = ts(ev);
  let i = 0;
  while (i < events.length && ts(events[i]!) > t) i++;
  const next = [...events.slice(0, i), ev, ...events.slice(i)];
  return next.length > max ? next.slice(0, max) : next;
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case "open":
      return { ...state, status: "live", attempt: 0, retryAt: null };
    case "error":
      return { ...state, status: "reconnecting", attempt: state.attempt + 1, retryAt: action.retryAt };
    case "activity": {
      const events = insertEvent(state.events, action.event);
      return events === state.events ? state : { ...state, events };
    }
    case "health":
      return { ...state, health: action.health };
  }
}

/** Exponential backoff with full jitter: 1 s, 2 s, 4 s … capped at 30 s. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + (random() * base) / 2);
}

/** Parse an SSE `data:` payload; null when it isn't a usable ActivityEvent. */
export function parseActivity(raw: string): ActivityEvent | null {
  try {
    const v = JSON.parse(raw) as Partial<ActivityEvent>;
    if (typeof v?.event_id !== "string" || typeof v.event_type !== "string") return null;
    return {
      event_id: v.event_id,
      event_type: v.event_type,
      topic: typeof v.topic === "string" ? v.topic : "",
      key: typeof v.key === "string" ? v.key : "",
      occurred_at: typeof v.occurred_at === "string" ? v.occurred_at : new Date().toISOString(),
      summary: typeof v.summary === "string" ? v.summary : "",
      data: v.data && typeof v.data === "object" ? v.data : {},
    };
  } catch {
    return null;
  }
}

export function parseHealth(raw: string): HealthResponse | null {
  try {
    const v = JSON.parse(raw) as Partial<HealthResponse>;
    if (!Array.isArray(v?.services)) return null;
    return { services: v.services, checked_at: typeof v.checked_at === "string" ? v.checked_at : "" };
  } catch {
    return null;
  }
}
