import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { StaticTokenVerifier } from "../src/auth.js";
import type { CardLookupHandler } from "../src/card-lookups.js";
import { ApplicationError } from "../src/errors.js";
import { MemoryRepository } from "../src/memory-repository.js";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const imageDataUrl = `data:image/png;base64,${pngBase64}`;

const collectorHeaders = { authorization: "Bearer collector-token" };

async function buildMainApp(
  lookup: CardLookupHandler["lookup"],
): Promise<FastifyInstance> {
  return buildApp({
    repository: new MemoryRepository(),
    tokenVerifier: new StaticTokenVerifier(new Map()),
    cardLookupTokenVerifier: new StaticTokenVerifier(
      new Map([
        [
          "collector-token",
          { userId: "collector", email: "collector@example.test", roles: [] },
        ],
      ]),
    ),
    cardLookupService: { lookup } as CardLookupHandler,
  });
}

describe("main app card-lookup mount", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns 429 rate_limited, not 500, when the global limiter is exhausted (G26)", async () => {
    app = await buildMainApp(vi.fn());
    let lastResponse;
    for (let i = 0; i < 121; i += 1) {
      lastResponse = await app.inject({ method: "GET", url: "/health" });
    }
    expect(lastResponse!.statusCode).toBe(429);
    expect(lastResponse!.json()).toMatchObject({ error: "rate_limited" });
    expect(lastResponse!.headers["retry-after"]).toBeDefined();
  });

  it("refunds the hourly quota unit when a lookup fails server-side (G7)", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(
        new ApplicationError(
          502,
          "card_recognition_unavailable",
          "The card recognition provider is temporarily unavailable.",
        ),
      )
      .mockResolvedValue({ candidates: [], warnings: [] });
    app = await buildMainApp(lookup as unknown as CardLookupHandler["lookup"]);

    const failed = await app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: collectorHeaders,
      payload: { imageDataUrl },
    });
    expect(failed.statusCode).toBe(502);

    const succeeded = await app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: collectorHeaders,
      payload: { imageDataUrl },
    });
    expect(succeeded.statusCode).toBe(200);
    // The failed lookup's unit was refunded, so this success is the first
    // charged unit of the hour: 30 - 1 = 29 remaining.
    expect(succeeded.headers["x-ratelimit-remaining"]).toBe("29");
  });
});
