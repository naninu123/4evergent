/**
 * #109: default Idempotency-Key replay window (24 hours).
 *
 * A key suppresses a repeated request only while the activity it is bound to
 * is younger than the window. Before #109 keys never expired, so the default
 * is deliberately long: it covers every realistic client retry (network
 * timeouts, process restarts, queued mobile retries) and matches the common
 * 24-hour convention for payment APIs.
 */
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Options shared by both ActivityStore backends. */
export interface ActivityStoreOptions {
  /**
   * Idempotency-Key replay window in milliseconds. Non-finite or non-positive
   * values fall back to DEFAULT_IDEMPOTENCY_WINDOW_MS: a key can never be
   * configured to expire immediately.
   */
  idempotencyWindowMs?: number;
  /** Clock in epoch milliseconds, for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Resolve a configured window, falling back to the default when invalid. */
export function resolveIdempotencyWindowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_IDEMPOTENCY_WINDOW_MS;
}

/** ISO-8601 instant before which an Idempotency-Key no longer suppresses requests. */
export function idempotencyCutoff(nowMs: number, windowMs: number): string {
  return new Date(nowMs - windowMs).toISOString();
}
