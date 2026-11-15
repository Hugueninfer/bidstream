import type { ActivityEvent } from "../types.js";
import { ActivityBuffer, BUFFER_CAPACITY } from "./buffer.js";

export type ActivityListener = (event: ActivityEvent) => void;

/** Per-tenant activity buffers plus fan-out to live SSE subscribers. */
export class ActivityHub {
  private readonly buffers = new Map<string, ActivityBuffer>();
  private readonly listeners = new Map<string, Set<ActivityListener>>();

  constructor(private readonly capacity = BUFFER_CAPACITY) {}

  publish(tenantId: string, event: ActivityEvent): void {
    let buffer = this.buffers.get(tenantId);
    if (!buffer) {
      buffer = new ActivityBuffer(this.capacity);
      this.buffers.set(tenantId, buffer);
    }
    if (!buffer.add(event)) return;
    for (const listener of this.listeners.get(tenantId) ?? []) {
      try {
        listener(event);
      } catch {
        // One broken subscriber must not starve the others.
      }
    }
  }

  /** Newest `n` events for the tenant, oldest first. */
  recent(tenantId: string, n: number): ActivityEvent[] {
    return this.buffers.get(tenantId)?.latest(n) ?? [];
  }

  /** Events after `eventId` (for SSE Last-Event-ID resume); null if it fell out of the buffer. */
  since(tenantId: string, eventId: string): ActivityEvent[] | null {
    return this.buffers.get(tenantId)?.after(eventId) ?? null;
  }

  subscribe(tenantId: string, listener: ActivityListener): () => void {
    let set = this.listeners.get(tenantId);
    if (!set) {
      set = new Set();
      this.listeners.set(tenantId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(tenantId);
    };
  }

  subscriberCount(tenantId?: string): number {
    if (tenantId !== undefined) return this.listeners.get(tenantId)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}
