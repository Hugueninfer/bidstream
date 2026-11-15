import type { ActivityEvent } from "../types.js";

export const BUFFER_CAPACITY = 200;

const timeOf = (e: ActivityEvent) => Date.parse(e.occurred_at) || 0;

/**
 * Fixed-capacity buffer of the newest events, ordered by `occurred_at`.
 *
 * For in-order arrivals it behaves like a ring buffer (append, drop oldest).
 * It also tolerates the interleaving we get when replaying two topics from the
 * beginning: late arrivals are inserted in place, and events older than
 * everything in a full buffer are dropped. Duplicate event_ids are ignored,
 * since Kafka delivery is at-least-once.
 */
export class ActivityBuffer {
  private readonly events: ActivityEvent[] = [];
  private readonly ids = new Set<string>();

  constructor(readonly capacity = BUFFER_CAPACITY) {
    if (capacity < 1) throw new Error("capacity must be positive");
  }

  get size(): number {
    return this.events.length;
  }

  /** Returns true when the event was stored. */
  add(event: ActivityEvent): boolean {
    if (this.ids.has(event.event_id)) return false;
    const t = timeOf(event);
    const full = this.events.length >= this.capacity;
    if (full && t < timeOf(this.events[0]!)) return false;

    // Walk back from the end: usually zero steps.
    let i = this.events.length;
    while (i > 0 && timeOf(this.events[i - 1]!) > t) i--;
    this.events.splice(i, 0, event);
    this.ids.add(event.event_id);

    if (this.events.length > this.capacity) {
      const evicted = this.events.shift()!;
      this.ids.delete(evicted.event_id);
    }
    return true;
  }

  /** The newest `n` events, oldest first. */
  latest(n: number): ActivityEvent[] {
    return n <= 0 ? [] : this.events.slice(-n);
  }

  /** Events stored after the one with `eventId`, oldest first; null if it is not in the buffer. */
  after(eventId: string): ActivityEvent[] | null {
    const idx = this.events.findIndex((e) => e.event_id === eventId);
    return idx === -1 ? null : this.events.slice(idx + 1);
  }
}
