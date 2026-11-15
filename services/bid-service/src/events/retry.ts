import { setTimeout as sleep } from 'node:timers/promises';
import { PermanentEventError } from './envelope.js';

/** Backoff between attempts (docs/contracts.md): 4 attempts in total. */
export const RETRY_DELAYS_MS = [200, 1_000, 3_000] as const;

export type RetryResult<T> = { ok: true; value: T; attempts: number } | { ok: false; error: unknown; attempts: number };

/**
 * Runs `fn`, retrying after each delay in `delays`. Permanent errors (bad
 * payloads) are not retried: the outcome would be the same every time.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  opts: {
    delays?: readonly number[];
    wait?: (ms: number) => Promise<unknown>;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void | Promise<void>;
  } = {},
): Promise<RetryResult<T>> {
  const delays = opts.delays ?? RETRY_DELAYS_MS;
  const wait = opts.wait ?? ((ms: number) => sleep(ms));
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, value: await fn(), attempts: attempt };
    } catch (error) {
      const delay = delays[attempt - 1];
      if (error instanceof PermanentEventError || delay === undefined) return { ok: false, error, attempts: attempt };
      await opts.onRetry?.(error, attempt, delay);
      await wait(delay);
    }
  }
}
