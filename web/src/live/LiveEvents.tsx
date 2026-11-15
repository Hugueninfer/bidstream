/* eslint-disable react-refresh/only-export-components -- provider + its hooks live together */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { eventsUrl } from "../api/client";
import { qk } from "../api/queries";
import type { ActivityEvent } from "../api/types";
import {
  backoffDelay,
  initialLiveState,
  liveReducer,
  parseActivity,
  parseHealth,
  type LiveState,
} from "./eventReducer";

type Listener = (ev: ActivityEvent) => void;

type LiveContextValue = LiveState & {
  /** Subscribe to every *new* activity event (duplicates from replays are filtered out). */
  subscribe: (fn: Listener) => () => void;
};

const LiveContext = createContext<LiveContextValue | null>(null);

/** One shared EventSource on /v1/events for the whole app, with backoff reconnects. */
export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const listeners = useRef(new Set<Listener>());
  const seen = useRef(new Set<string>());
  const attemptRef = useRef(0);
  const queryClient = useQueryClient();

  // Batch invalidations: the replay of the last 50 events on (re)connect would otherwise trigger 50 refetches.
  const pending = useRef(new Map<string, readonly unknown[]>());
  const flushTimer = useRef<number | null>(null);
  const invalidate = (key: readonly unknown[]) => {
    pending.current.set(JSON.stringify(key), key);
    if (flushTimer.current !== null) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null;
      const keys = [...pending.current.values()];
      pending.current.clear();
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    }, 150);
  };
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: number | null = null;
    let disposed = false;

    const onActivity = (msg: MessageEvent<string>) => {
      const ev = parseActivity(msg.data);
      if (!ev || seen.current.has(ev.event_id)) return;
      seen.current.add(ev.event_id);
      if (seen.current.size > 2000) seen.current = new Set([...seen.current].slice(-1000));
      dispatch({ type: "activity", event: ev });

      const inv = invalidateRef.current;
      switch (ev.event_type) {
        case "rfq.created":
          inv(qk.rfqsAll);
          break;
        case "rfq.awarded":
          inv(qk.rfqsAll);
          inv(qk.rfq(ev.key));
          inv(qk.bids(ev.key));
          break;
        case "bid.submitted":
          inv(qk.rfqsAll);
          inv(qk.rfq(ev.key));
          break; // the bids list is refetched by whoever shows it (RfqDetailPage), so it can flash the new row
      }
      for (const fn of listeners.current) fn(ev);
    };

    const onHealth = (msg: MessageEvent<string>) => {
      const health = parseHealth(msg.data);
      if (health) dispatch({ type: "health", health });
    };

    const connect = () => {
      if (disposed) return;
      es = new EventSource(eventsUrl());
      es.addEventListener("open", () => {
        attemptRef.current = 0;
        dispatch({ type: "open" });
      });
      es.addEventListener("activity", onActivity as EventListener);
      es.addEventListener("health", onHealth as EventListener);
      es.addEventListener("error", () => {
        // Take over reconnection from the browser so we control backoff and the indicator.
        es?.close();
        es = null;
        const delay = backoffDelay(attemptRef.current);
        attemptRef.current += 1;
        dispatch({ type: "error", retryAt: Date.now() + delay });
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      es?.close();
    };
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const value = useMemo<LiveContextValue>(() => ({ ...state, subscribe }), [state, subscribe]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive must be used inside <LiveEventsProvider>");
  return ctx;
}

/** Run `handler` for each new activity event. The latest handler is always used. */
export function useLiveEvent(handler: Listener) {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((ev) => ref.current(ev)), [subscribe]);
}
