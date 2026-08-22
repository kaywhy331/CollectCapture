import { CardLookupRequestSchema } from "@localclear/domain";
import type { FastifyPluginAsync } from "fastify";
import { createAuthenticationHook, type TokenVerifier } from "./auth.js";
import type { CardLookupHandler } from "./card-lookups.js";

export interface CardLookupHttpOptions {
  tokenVerifier: TokenVerifier;
  service: CardLookupHandler;
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

  app.addHook("preHandler", async (request, reply) => {
    await authenticate(request, reply);
    if (reply.sent) return;

    const limit = await checkRateLimit(request);
    if (limit.isAllowed) return;

    reply
      .header("x-ratelimit-limit", limit.max)
      .header("x-ratelimit-remaining", limit.remaining)
      .header("x-ratelimit-reset", limit.ttlInSeconds);
    if (!limit.isExceeded) return;

    await reply.code(429).header("retry-after", limit.ttlInSeconds).send({
      error: "rate_limited",
      message: "Too many card lookups. Please try again later.",
    });
  });

  app.post(
    "/v1/card-lookups",
    {
      bodyLimit: 3_000_000,
    },
    async (request, reply) => {
      const input = CardLookupRequestSchema.parse(request.body);
      const lookup = await options.service.lookup(input, {
        authorization: request.headers.authorization!,
      });
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send({ lookup });
    },
  );
};
