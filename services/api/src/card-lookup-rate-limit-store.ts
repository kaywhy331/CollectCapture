/**
 * A @fastify/rate-limit store, functionally equivalent to the library's
 * built-in `LocalStore`, plus a `refund` a caller can use to give back a
 * unit it charged for a request that turned out to fail server-side (G7).
 * The library itself has no decrement/refund primitive in this version.
 *
 * @fastify/rate-limit calls `store.child(routeOptions)` to derive a
 * separate counter set for each route-scoped limit and each
 * `app.createRateLimit(...)` call (see the per-user 30/hour quota in
 * `card-lookup-http.ts`), and the constructed store instance is never
 * handed back to application code -- only the plugin sees it.
 *
 * Isolation matches the library exactly: the root store and every
 * `child()` each own a private map, so two limiters that happen to key on
 * the same string (the main LocalClear app's global limiter and its
 * route-scoped limits all key on the raw client IP) can never read or
 * clobber each other's counters. `createRefundableRateLimitStore()` keeps
 * a registry of every map its `Store` class creates, and `refund(key)`
 * decrements the key wherever it is found -- callers only ever refund
 * namespaced per-user quota keys (`collectfolio-card-lookups:...`), which
 * exist in exactly one child's map. Calling the factory fresh per app
 * build keeps state from leaking between independently built apps (for
 * example, separate test cases).
 */

interface RateLimitEntry {
  current: number;
  ttl: number;
  iterationStartMs: number;
}

/** Matches the library's own `LocalStore` default so this store bounds
 * memory the same way under many distinct keys (e.g. many source IPs). */
const DEFAULT_STORE_CAPACITY = 5_000;

function childFlags(routeOptions: unknown): {
  continueExceeding: boolean;
  exponentialBackoff: boolean;
} {
  const options =
    typeof routeOptions === "object" && routeOptions !== null
      ? (routeOptions as {
          continueExceeding?: boolean;
          exponentialBackoff?: boolean;
        })
      : {};
  return {
    continueExceeding: Boolean(options.continueExceeding),
    exponentialBackoff: Boolean(options.exponentialBackoff),
  };
}

/** The @fastify/rate-limit store shape (`incr`/`child`) this module
 * implements. Named so `child()` below can declare it returns another
 * store satisfying this same shape, instead of `unknown`. */
interface FastifyCompatibleStore {
  incr(
    key: string,
    callback: (
      error: Error | null,
      result?: { current: number; ttl: number },
    ) => void,
    timeWindow: number,
    max: number,
  ): void;
  child(routeOptions?: unknown): FastifyCompatibleStore;
}

export interface RefundableRateLimitStore {
  /** A @fastify/rate-limit-compatible store class, for the plugin's own
   * `store` registration option. */
  Store: new (options?: unknown) => FastifyCompatibleStore;
  /**
   * Gives back one previously-charged unit for `key`, floored at zero, in
   * every limiter map that currently holds `key`. Never extends or resets
   * the window -- a refund only reduces how many of the window's units are
   * considered spent. A no-op for a key with no live entry (the window
   * already rolled over, or nothing was ever charged), which is exactly
   * the "nothing to refund" case. Only refund namespaced keys that a
   * single limiter charges (the per-user quota keys) -- an un-namespaced
   * key could exist in several limiters' maps and would be refunded in
   * each.
   */
  refund(key: string): void;
}

export function createRefundableRateLimitStore(): RefundableRateLimitStore {
  const allEntryMaps = new Set<Map<string, RateLimitEntry>>();

  function touch(
    entries: Map<string, RateLimitEntry>,
    key: string,
    entry: RateLimitEntry,
  ): void {
    // Map iteration order is insertion order; deleting and re-setting
    // bumps this key to the most-recently-used end so eviction below
    // drops the actual least-recently-used entry, not an arbitrary one.
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > DEFAULT_STORE_CAPACITY) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) entries.delete(oldestKey);
    }
  }

  class Store {
    readonly #entries = new Map<string, RateLimitEntry>();
    readonly #continueExceeding: boolean;
    readonly #exponentialBackoff: boolean;

    constructor(options?: unknown) {
      const flags = childFlags(options);
      this.#continueExceeding = flags.continueExceeding;
      this.#exponentialBackoff = flags.exponentialBackoff;
      allEntryMaps.add(this.#entries);
    }

    incr(
      key: string,
      callback: (
        error: Error | null,
        result?: { current: number; ttl: number },
      ) => void,
      timeWindow: number,
      max: number,
    ): void {
      const nowMs = Date.now();
      let entry = this.#entries.get(key);
      if (!entry) {
        entry = { current: 1, ttl: timeWindow, iterationStartMs: nowMs };
      } else if (entry.iterationStartMs + timeWindow <= nowMs) {
        entry.current = 1;
        entry.ttl = timeWindow;
        entry.iterationStartMs = nowMs;
      } else {
        entry.current += 1;
        if (this.#continueExceeding && entry.current > max) {
          entry.ttl = timeWindow;
          entry.iterationStartMs = nowMs;
        } else if (this.#exponentialBackoff && entry.current > max) {
          const backoffExponent = entry.current - max - 1;
          const ttl = timeWindow * 2 ** backoffExponent;
          entry.ttl = Number.isSafeInteger(ttl) ? ttl : Number.MAX_SAFE_INTEGER;
          entry.iterationStartMs = nowMs;
        } else {
          entry.ttl = timeWindow - (nowMs - entry.iterationStartMs);
        }
      }
      touch(this.#entries, key, entry);
      callback(null, { current: entry.current, ttl: entry.ttl });
    }

    child(routeOptions?: unknown): Store {
      return new Store(routeOptions);
    }
  }

  return {
    Store,
    refund(key: string): void {
      for (const entries of allEntryMaps) {
        const entry = entries.get(key);
        if (entry) entry.current = Math.max(0, entry.current - 1);
      }
    },
  };
}
