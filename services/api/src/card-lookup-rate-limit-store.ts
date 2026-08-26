/**
 * A @fastify/rate-limit store, functionally equivalent to the library's
 * built-in `LocalStore`, plus a `refund` a caller can use to give back a
 * unit it charged for a request that turned out to fail server-side (G7).
 * The library itself has no decrement/refund primitive in this version.
 *
 * @fastify/rate-limit calls `store.child(routeOptions)` to derive a
 * separate counter set for each `app.createRateLimit(...)` call (see the
 * per-user 30/hour quota in `card-lookup-http.ts`), and the constructed
 * store instance is never handed back to application code -- only the
 * plugin sees it. `createRefundableRateLimitStore()` closes a fresh `Map`
 * over a dedicated `Store` class and returns both, so the caller (one
 * `buildCardLookupApp` call) can register the class with
 * `@fastify/rate-limit` while keeping a `refund` function that reaches the
 * exact same backing map -- the root store and every `child()` of it all
 * close over this one `Map`, the same way the library's own `LocalStore`
 * keeps a per-registration cache, just shared across `child()` instead of
 * split by it. That sharing is safe only because every caller in this
 * codebase keys its buckets from disjoint namespaces (the global limiter
 * uses a raw socket/`cf-connecting-ip` address; the per-user quota
 * prefixes its key with `collectfolio-card-lookups:`), so two
 * differently-configured limiters can never collide on the same key.
 * Calling the factory fresh per app build also keeps state from leaking
 * between independently built apps (for example, separate test cases).
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
   * Gives back one previously-charged unit for `key`, floored at zero.
   * Never extends or resets the window -- a refund only reduces how many
   * of the window's units are considered spent. A no-op for a key with no
   * live entry (the window already rolled over, or nothing was ever
   * charged), which is exactly the "nothing to refund" case.
   */
  refund(key: string): void;
}

export function createRefundableRateLimitStore(): RefundableRateLimitStore {
  const entries = new Map<string, RateLimitEntry>();

  function touch(key: string, entry: RateLimitEntry): void {
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
    readonly #continueExceeding: boolean;
    readonly #exponentialBackoff: boolean;

    constructor(options?: unknown) {
      const flags = childFlags(options);
      this.#continueExceeding = flags.continueExceeding;
      this.#exponentialBackoff = flags.exponentialBackoff;
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
      let entry = entries.get(key);
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
      touch(key, entry);
      callback(null, { current: entry.current, ttl: entry.ttl });
    }

    child(routeOptions?: unknown): Store {
      return new Store(routeOptions);
    }
  }

  return {
    Store,
    refund(key: string): void {
      const entry = entries.get(key);
      if (!entry) return;
      entry.current = Math.max(0, entry.current - 1);
    },
  };
}
