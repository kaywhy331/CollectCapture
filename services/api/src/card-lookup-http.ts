import { CardLookupRequestSchema } from "@localclear/domain";
import type { FastifyPluginAsync } from "fastify";
import { createAuthenticationHook, type TokenVerifier } from "./auth.js";
import {
  ClientDisconnectedError,
  type CardLookupHandler,
} from "./card-lookups.js";

export interface CardLookupHttpOptions {
  tokenVerifier: TokenVerifier;
  service: CardLookupHandler;
  /**
   * Caps concurrent vision-recognition calls (manual-query lookups skip
   * vision entirely and are never gated). Defaults to 2, matching
   * `CARD_LOOKUP_MAX_CONCURRENCY`'s default.
   */
  maxConcurrentVisionLookups?: number;
}

/**
 * A tiny inline counting semaphore. `tryAcquire` never waits: it either
 * returns a release function for an immediately available slot or
 * `undefined` when none is free, so a caller can fail fast with a busy
 * response instead of queuing.
 */
class VisionConcurrencyGate {
  #availableSlots: number;

  constructor(maxConcurrency: number) {
    this.#availableSlots = maxConcurrency;
  }

  tryAcquire(): (() => void) | undefined {
    if (this.#availableSlots <= 0) return undefined;
    this.#availableSlots -= 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#availableSlots += 1;
    };
  }
}

export const cardLookupHttpPlugin: FastifyPluginAsync<
  CardLookupHttpOptions
> = async (app, options) => {
  const authenticate = createAuthenticationHook(options.tokenVerifier);
  const checkRateLimit = app.createRateLimit({
    max: 30,
    timeWindow: "1 hour",
    keyGenerator: (request) =>
      `collectfolio-card-lookups:${request.principal.userId}`,
  });
  const visionSlots = new VisionConcurrencyGate(
    options.maxConcurrentVisionLookups ?? 2,
  );

  app.addHook("preHandler", authenticate);

  app.post(
    "/v1/card-lookups",
    {
      bodyLimit: 3_000_000,
    },
    async (request, reply) => {
      const input = CardLookupRequestSchema.parse(request.body);

      // Cancel the lookup's provider/catalog calls if the client goes away
      // before a response is sent. This listens on the *response* socket
      // (`reply.raw`), not the request: `request.raw`'s own "close" fires
      // once its body is fully read -- normal for every lookup, since the
      // request is fully parsed well before a response exists -- and is not
      // a usable disconnect signal. `reply.raw`'s "close" fires only when
      // the underlying connection tears down before the response finishes,
      // which is exactly premature client disconnect; the `reply.sent`
      // guard still keeps an already-completed request from aborting
      // anything once that same event fires later during normal teardown.
      const abortController = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.sent) abortController.abort();
      });

      // Only a vision-recognition lookup (an empty collector query) needs a
      // slot; a manual-query lookup skips vision and must never be gated.
      const needsVisionSlot = input.query.length === 0;
      const releaseVisionSlot = needsVisionSlot
        ? visionSlots.tryAcquire()
        : undefined;
      if (needsVisionSlot && !releaseVisionSlot) {
        // Busy: reject before charging the user's hourly quota unit.
        await reply.code(503).header("retry-after", "5").send({
          error: "card_lookup_busy",
          message:
            "CollectCapture is at capacity for card recognition right now. Please try again in a few seconds.",
        });
        return;
      }

      try {
        // Charge the quota only once a lookup is actually going to run, so
        // a busy rejection above never consumes it.
        const limit = await checkRateLimit(request);
        if (!limit.isAllowed) {
          reply
            .header("x-ratelimit-limit", limit.max)
            .header("x-ratelimit-remaining", limit.remaining)
            .header("x-ratelimit-reset", limit.ttlInSeconds);
          if (limit.isExceeded) {
            await reply
              .code(429)
              .header("retry-after", limit.ttlInSeconds)
              .send({
                error: "rate_limited",
                message: "Too many card lookups. Please try again later.",
              });
            return;
          }
        }

        const lookup = await options.service.lookup(input, {
          authorization: request.headers.authorization!,
          signal: abortController.signal,
        });
        return reply
          .header("cache-control", "no-store")
          .header("pragma", "no-cache")
          .send({ lookup });
      } catch (error) {
        if (error instanceof ClientDisconnectedError) {
          // The client is gone: this is its own outcome, not a provider or
          // catalog failure, and there is nobody left to send a body to.
          request.log.info(
            { outcome: "client_disconnected" },
            "Card lookup abandoned: client disconnected",
          );
          reply.hijack();
          return;
        }
        throw error;
      } finally {
        releaseVisionSlot?.();
      }
    },
  );
};
