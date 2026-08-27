import { CardLookupRequestSchema } from "@localclear/domain";
import type { FastifyPluginAsync } from "fastify";
import { createAuthenticationHook, type TokenVerifier } from "./auth.js";
import {
  ClientDisconnectedError,
  type CardLookupHandler,
  type CardLookupPhaseTiming,
} from "./card-lookups.js";
import { ApplicationError } from "./errors.js";
import {
  recordCardLookupBusy,
  recordCardLookupCatalogDuration,
  recordCardLookupMediaRejected,
  recordCardLookupOutcome,
  recordCardLookupProviderFailure,
  recordCardLookupRateLimited,
  recordCardLookupRecognitionDuration,
} from "./observability.js";

/** `ApplicationError` codes that mean the uploaded image itself was
 * rejected by media verification, before any recognition/catalog phase
 * ran (G12). Kept in sync with the codes `media-verification.ts` and
 * `verifiedCardImage` in `card-lookups.ts` actually throw. */
const MEDIA_REJECTION_CODES = new Set([
  "invalid_card_image",
  "media_type_mismatch",
  "media_hash_mismatch",
  "media_metadata_invalid",
  "media_location_present",
  "media_too_large",
  "media_resolution_too_low",
]);

export interface CardLookupHttpOptions {
  tokenVerifier: TokenVerifier;
  service: CardLookupHandler;
  /**
   * Caps concurrent vision-recognition calls (manual-query lookups skip
   * vision entirely and are never gated). Defaults to 2, matching
   * `CARD_LOOKUP_MAX_CONCURRENCY`'s default.
   */
  maxConcurrentVisionLookups?: number;
  /**
   * Gives back one charged hourly-quota unit for a key produced by this
   * plugin's own rate-limit `keyGenerator` (G7). Omitted by a caller whose
   * rate-limit plugin registration does not use a refundable store (today,
   * the main LocalClear app's `/v1/card-lookups` mount) -- refunding is
   * then simply skipped, matching that caller's pre-G7 behavior exactly.
   */
  refundQuota?: (key: string) => void;
}

/** Prefixes every per-user quota key so it can never collide with the
 * global limiter's own (raw IP/`cf-connecting-ip`) keys in a shared
 * refundable store (see card-lookup-rate-limit-store.ts). */
function cardLookupQuotaKey(userId: string): string {
  return `collectfolio-card-lookups:${userId}`;
}

/**
 * Whether a lookup failure should give back its already-charged quota unit
 * (G7a): any outcome that resolves to a 5xx response, plus a client
 * disconnect (nobody received a response at all, so nothing was actually
 * delivered for the charge). A client-caused failure (a 4xx
 * `ApplicationError`, such as a rejected image) is never refunded -- the
 * lookup did run and did tell the caller something concrete.
 */
function isRefundableLookupFailure(error: unknown): boolean {
  if (error instanceof ClientDisconnectedError) return true;
  if (error instanceof ApplicationError) return error.statusCode >= 500;
  return true;
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
    keyGenerator: (request) => cardLookupQuotaKey(request.principal.userId),
  });
  const refundQuota = options.refundQuota ?? (() => {});
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

      const provider = options.service.recognitionProviderName ?? "unknown";
      const model = options.service.recognitionModel ?? "unknown";

      // Only a vision-recognition lookup (an empty collector query) needs a
      // slot; a manual-query lookup skips vision and must never be gated.
      const needsVisionSlot = input.query.length === 0;
      const releaseVisionSlot = needsVisionSlot
        ? visionSlots.tryAcquire()
        : undefined;
      if (needsVisionSlot && !releaseVisionSlot) {
        // Busy: reject before charging the user's hourly quota unit.
        recordCardLookupBusy();
        recordCardLookupOutcome("busy", provider);
        request.log.info(
          { provider, model, outcome: "busy" },
          "Card lookup rejected: recognition capacity busy",
        );
        await reply.code(503).header("retry-after", "5").send({
          error: "card_lookup_busy",
          message:
            "CollectCapture is at capacity for card recognition right now. Please try again in a few seconds.",
        });
        return;
      }

      const quotaKey = cardLookupQuotaKey(request.principal.userId);
      // Populated by the service's per-phase timing callback (G12a); a
      // manual-query lookup never sets `recognitionMs` (no recognition
      // phase runs), and a lookup that fails before the catalog phase
      // starts never sets `catalogMs`.
      let recognitionMs: number | undefined;
      let catalogMs: number | undefined;
      const onPhaseComplete = (timing: CardLookupPhaseTiming): void => {
        if (timing.phase === "recognition") recognitionMs = timing.durationMs;
        else catalogMs = timing.durationMs;
      };

      try {
        // Charge the quota only once a lookup is actually going to run, so
        // a busy rejection above never consumes it.
        const limit = await checkRateLimit(request);
        // `limit.isAllowed` is only ever `true` for an allow-listed caller
        // (this route configures no allow list), so this branch runs on
        // every request and reliably stamps the standard rate-limit
        // headers on a SUCCESSFUL response too, not just a throttled one.
        if (!limit.isAllowed) {
          reply
            .header("x-ratelimit-limit", limit.max)
            .header("x-ratelimit-remaining", limit.remaining)
            .header("x-ratelimit-reset", limit.ttlInSeconds);
          if (limit.isExceeded) {
            recordCardLookupRateLimited();
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
          onPhaseComplete,
        });
        if (recognitionMs !== undefined) {
          recordCardLookupRecognitionDuration(
            recognitionMs,
            provider,
            "success",
          );
        }
        if (catalogMs !== undefined) {
          recordCardLookupCatalogDuration(catalogMs, provider, "success");
        }
        recordCardLookupOutcome("success", provider);
        request.log.info(
          {
            provider,
            model,
            recognitionMs,
            catalogMs,
            candidateCount: lookup.candidates.length,
            outcome: "success",
            quotaRemaining: limit.isAllowed ? undefined : limit.remaining,
          },
          "Card lookup completed",
        );
        return reply
          .header("cache-control", "no-store")
          .header("pragma", "no-cache")
          .send({ lookup });
      } catch (error) {
        // A lookup that was charged but never actually delivered anything
        // to the caller -- a server-side (5xx) failure, or the client
        // disconnecting before a response could be sent -- gives back its
        // quota unit. A client-caused failure (a rejected image, for
        // example) keeps the charge: the lookup did run.
        if (isRefundableLookupFailure(error)) refundQuota(quotaKey);

        const outcome =
          error instanceof ClientDisconnectedError
            ? "client_disconnected"
            : error instanceof ApplicationError
              ? error.code
              : "internal_error";
        if (recognitionMs !== undefined) {
          recordCardLookupRecognitionDuration(recognitionMs, provider, outcome);
        }
        if (catalogMs !== undefined) {
          recordCardLookupCatalogDuration(catalogMs, provider, outcome);
        }
        recordCardLookupOutcome(outcome, provider);
        if (MEDIA_REJECTION_CODES.has(outcome)) {
          recordCardLookupMediaRejected(outcome);
        } else if (outcome.startsWith("card_recognition_")) {
          recordCardLookupProviderFailure(provider, outcome);
        }
        // NEVER log image bytes, bearer tokens, or raw model output here --
        // only the classified outcome and timing metadata above.
        request.log.info(
          {
            provider,
            model,
            recognitionMs,
            catalogMs,
            outcome,
          },
          "Card lookup did not complete",
        );

        if (error instanceof ClientDisconnectedError) {
          // The client is gone: this is its own outcome, not a provider or
          // catalog failure, and there is nobody left to send a body to.
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
