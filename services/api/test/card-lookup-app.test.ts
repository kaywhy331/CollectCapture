import { CardLookupResultSchema } from "@localclear/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCardLookupApp } from "../src/card-lookup-app.js";
import { readCardLookupConfig } from "../src/card-lookup-config.js";
import { StaticTokenVerifier } from "../src/auth.js";

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const imageDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const lookup = CardLookupResultSchema.parse({
  contentSha256: "a".repeat(64),
  imageRetained: false,
  recognition: {
    source: "user_query",
    category: "pokemon",
    name: null,
    setName: null,
    collectorNumber: null,
    language: "und",
    visibleText: [],
    queries: ["Charizard 4/102"],
    confidence: 1,
    provider: "collector",
    model: "manual-query",
  },
  candidates: [],
  warnings: [],
});

describe("standalone card lookup service", () => {
  const apps: Awaited<ReturnType<typeof buildCardLookupApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("reads only lookup-specific runtime configuration", () => {
    const config = readCardLookupConfig({
      OPENAI_API_KEY: "openai-key-that-is-at-least-20-characters",
      COLLECTFOLIO_APP_URL: "https://folio.example.test",
      COLLECTFOLIO_SUPABASE_URL: "https://folio-project.example.test",
      COLLECTFOLIO_CATALOG_URL: "https://catalog.example.test",
    });

    expect(config).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 4100,
      CARD_RECOGNITION_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.6",
      OLLAMA_MODEL: "qwen3.5:4b",
      GROQ_MODEL: "qwen/qwen3.6-27b",
    });
    expect(config).not.toHaveProperty("DATABASE_URL");
    expect(() =>
      readCardLookupConfig({
        OPENAI_API_KEY: "openai-key-that-is-at-least-20-characters",
        COLLECTFOLIO_APP_URL: "http://folio.example.test",
        COLLECTFOLIO_SUPABASE_URL: "https://folio-project.example.test",
        COLLECTFOLIO_CATALOG_URL: "https://catalog.example.test",
      }),
    ).toThrow("HTTPS outside localhost");
    expect(() =>
      readCardLookupConfig({
        OPENAI_API_KEY: "openai-key-that-is-at-least-20-characters",
        COLLECTFOLIO_APP_URL: "https://folio.example.test/scanner",
        COLLECTFOLIO_SUPABASE_URL: "https://folio-project.example.test",
        COLLECTFOLIO_CATALOG_URL: "https://catalog.example.test",
      }),
    ).toThrow("exact origin");
  });

  it("selects local Ollama, Ollama Cloud, or Groq without an OpenAI key", () => {
    const shared = {
      COLLECTFOLIO_APP_URL: "https://folio.example.test",
      COLLECTFOLIO_SUPABASE_URL: "https://folio-project.example.test",
      COLLECTFOLIO_CATALOG_URL: "https://catalog.example.test",
      OPENAI_API_KEY: "",
    };

    expect(
      readCardLookupConfig({
        ...shared,
        CARD_RECOGNITION_PROVIDER: "ollama",
      }),
    ).toMatchObject({
      CARD_RECOGNITION_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      OLLAMA_MODEL: "qwen3.5:4b",
    });
    expect(
      readCardLookupConfig({
        ...shared,
        CARD_RECOGNITION_PROVIDER: "ollama",
        OLLAMA_BASE_URL: "https://ollama.com",
        OLLAMA_API_KEY: "ollama-cloud-key-that-is-long-enough",
        OLLAMA_MODEL: "qwen3.5:397b",
      }),
    ).toMatchObject({
      OLLAMA_BASE_URL: "https://ollama.com",
      OLLAMA_MODEL: "qwen3.5:397b",
    });
    expect(
      readCardLookupConfig({
        ...shared,
        CARD_RECOGNITION_PROVIDER: "groq",
        GROQ_API_KEY: "x".repeat(20),
      }),
    ).toMatchObject({
      CARD_RECOGNITION_PROVIDER: "groq",
      GROQ_MODEL: "qwen/qwen3.6-27b",
    });
    expect(() =>
      readCardLookupConfig({
        CARD_RECOGNITION_PROVIDER: "ollama",
        COLLECTFOLIO_APP_URL: "http://localhost:4173",
        COLLECTFOLIO_SUPABASE_URL: "http://127.0.0.1:54321",
        COLLECTFOLIO_SUPABASE_JWKS_URL:
          "http://host.docker.internal:54321/auth/v1/.well-known/jwks.json",
        COLLECTFOLIO_CATALOG_URL: "http://host.docker.internal:8787",
      }),
    ).not.toThrow();
  });

  it("requires only the selected cloud provider secret", () => {
    const shared = {
      COLLECTFOLIO_APP_URL: "https://folio.example.test",
      COLLECTFOLIO_SUPABASE_URL: "https://folio-project.example.test",
      COLLECTFOLIO_CATALOG_URL: "https://catalog.example.test",
    };

    expect(() => readCardLookupConfig(shared)).toThrow("OPENAI_API_KEY");
    expect(() =>
      readCardLookupConfig({
        ...shared,
        CARD_RECOGNITION_PROVIDER: "ollama",
        OLLAMA_BASE_URL: "https://ollama.com",
      }),
    ).toThrow("OLLAMA_API_KEY");
    expect(() =>
      readCardLookupConfig({
        ...shared,
        CARD_RECOGNITION_PROVIDER: "groq",
      }),
    ).toThrow("GROQ_API_KEY");
  });

  it("starts and serves authenticated lookups without a repository", async () => {
    const performLookup = vi.fn(async () => lookup);
    const app = await buildCardLookupApp({
      allowedOrigin: "https://folio.example.test",
      tokenVerifier: new StaticTokenVerifier(
        new Map([
          ["folio-token", { userId: "folio-user", email: null, roles: [] }],
        ]),
      ),
      service: { lookup: performLookup },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const health = await fetch(`${address}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      service: "collectcapture-card-lookups",
    });

    const response = await fetch(`${address}/v1/card-lookups`, {
      method: "POST",
      headers: {
        authorization: "Bearer folio-token",
        "content-type": "application/json",
        origin: "https://folio.example.test",
      },
      body: JSON.stringify({
        imageDataUrl,
        query: "Charizard 4/102",
        category: "pokemon",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://folio.example.test",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ lookup });
    expect(performLookup).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Charizard 4/102" }),
      { authorization: "Bearer folio-token" },
    );

    const preflight = await fetch(`${address}/v1/card-lookups`, {
      method: "OPTIONS",
      headers: {
        origin: "https://folio.example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://folio.example.test",
    );
    expect(preflight.headers.get("access-control-max-age")).toBe("86400");
  });
});

describe("tunnel-mode rate limiting", () => {
  const apps: Awaited<ReturnType<typeof buildCardLookupApp>>[] = [];
  // The address the cloudflared sidecar itself connects from over the
  // private Compose network; a real Internet client cannot present this.
  const privateSocketAddress = "10.0.0.5";
  const publicSocketAddress = "203.0.113.99";
  const unreachableService = {
    async lookup(): Promise<never> {
      throw new Error("not called");
    },
  };

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function remainingAfter(
    app: Awaited<ReturnType<typeof buildCardLookupApp>>,
    init: { remoteAddress: string; cfConnectingIp: string },
  ): Promise<number> {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: init.remoteAddress,
      headers: { "cf-connecting-ip": init.cfConnectingIp },
    });
    expect(response.statusCode).toBe(200);
    return Number(response.headers["x-ratelimit-remaining"]);
  }

  it("keys the rate limiter on cf-connecting-ip when the socket is the private tunnel address", async () => {
    const app = await buildCardLookupApp({
      allowedOrigin: "https://folio.example.test",
      trustedProxyMode: "cloudflare-tunnel",
      tokenVerifier: new StaticTokenVerifier(new Map()),
      service: unreachableService,
    });
    apps.push(app);

    const visitorA1 = await remainingAfter(app, {
      remoteAddress: privateSocketAddress,
      cfConnectingIp: "203.0.113.10",
    });
    const visitorA2 = await remainingAfter(app, {
      remoteAddress: privateSocketAddress,
      cfConnectingIp: "203.0.113.10",
    });
    // Same header, same private socket: one shared, decrementing bucket.
    expect(visitorA2).toBe(visitorA1 - 1);

    const visitorB1 = await remainingAfter(app, {
      remoteAddress: privateSocketAddress,
      cfConnectingIp: "203.0.113.20",
    });
    // A different visitor's header opens an independent, fresh bucket.
    expect(visitorB1).toBe(visitorA1);
  });

  it("ignores a forged cf-connecting-ip header from a public source address", async () => {
    const app = await buildCardLookupApp({
      allowedOrigin: "https://folio.example.test",
      trustedProxyMode: "cloudflare-tunnel",
      tokenVerifier: new StaticTokenVerifier(new Map()),
      service: unreachableService,
    });
    apps.push(app);

    const first = await remainingAfter(app, {
      remoteAddress: publicSocketAddress,
      cfConnectingIp: "198.51.100.1",
    });
    // A different forged header value from the same public socket address
    // must land in the same bucket: the header is not trusted here.
    const second = await remainingAfter(app, {
      remoteAddress: publicSocketAddress,
      cfConnectingIp: "198.51.100.2",
    });
    expect(second).toBe(first - 1);
  });

  it("keeps default-mode rate limiting byte-for-byte unchanged", async () => {
    const app = await buildCardLookupApp({
      allowedOrigin: "https://folio.example.test",
      tokenVerifier: new StaticTokenVerifier(new Map()),
      service: unreachableService,
    });
    apps.push(app);

    const first = await remainingAfter(app, {
      remoteAddress: privateSocketAddress,
      cfConnectingIp: "203.0.113.10",
    });
    // A different header value from the same socket must not open a fresh
    // bucket outside cloudflare-tunnel mode: today's socket-only keying.
    const second = await remainingAfter(app, {
      remoteAddress: privateSocketAddress,
      cfConnectingIp: "203.0.113.20",
    });
    expect(second).toBe(first - 1);
  });
});

describe("vision concurrency gate", () => {
  const apps: Awaited<ReturnType<typeof buildCardLookupApp>>[] = [];
  const authHeaders = {
    authorization: "Bearer folio-token",
    origin: "https://folio.example.test",
  };

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function appWithService(
    service: { lookup: (...args: never[]) => Promise<unknown> },
    maxConcurrentVisionLookups = 1,
  ) {
    const app = await buildCardLookupApp({
      allowedOrigin: "https://folio.example.test",
      maxConcurrentVisionLookups,
      tokenVerifier: new StaticTokenVerifier(
        new Map([
          ["folio-token", { userId: "folio-user", email: null, roles: [] }],
        ]),
      ),
      service: service as never,
    });
    apps.push(app);
    return app;
  }

  it("returns an immediate 503 for a concurrent vision lookup beyond capacity", async () => {
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const app = await appWithService({
      async lookup() {
        firstStarted.resolve();
        await releaseFirst.promise;
        return lookup;
      },
    });

    const first = app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: authHeaders,
      payload: { imageDataUrl },
    });
    await firstStarted.promise;

    const second = await app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: authHeaders,
      payload: { imageDataUrl },
    });
    expect(second.statusCode).toBe(503);
    expect(second.headers["retry-after"]).toBe("5");
    expect(second.json()).toMatchObject({ error: "card_lookup_busy" });

    releaseFirst.resolve();
    expect((await first).statusCode).toBe(200);
  });

  it("never gates a manual-query lookup", async () => {
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    let callCount = 0;
    const app = await appWithService({
      async lookup() {
        callCount += 1;
        // Only the first (vision) call holds the only slot open; a manual
        // lookup arriving while it is held must not also block on it.
        if (callCount === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return lookup;
      },
    });

    const first = app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: authHeaders,
      payload: { imageDataUrl },
    });
    await firstStarted.promise;

    const manual = await app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: authHeaders,
      payload: { imageDataUrl, query: "Charizard 4/102" },
    });
    expect(manual.statusCode).toBe(200);

    releaseFirst.resolve();
    expect((await first).statusCode).toBe(200);
  });

  it("releases the slot after a provider error so a follow-up request succeeds", async () => {
    let callCount = 0;
    const app = await appWithService({
      async lookup() {
        callCount += 1;
        if (callCount === 1) throw new Error("provider exploded");
        return lookup;
      },
    });

    const failed = await app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: authHeaders,
      payload: { imageDataUrl },
    });
    expect(failed.statusCode).toBe(500);

    const succeeded = await app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: authHeaders,
      payload: { imageDataUrl },
    });
    expect(succeeded.statusCode).toBe(200);
  });

  it("does not consume the hourly quota for a busy rejection", async () => {
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const app = await appWithService({
      async lookup() {
        firstStarted.resolve();
        await releaseFirst.promise;
        return lookup;
      },
    });

    const first = app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: authHeaders,
      payload: { imageDataUrl },
    });
    await firstStarted.promise;

    const busy = await app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: authHeaders,
      payload: { imageDataUrl },
    });
    expect(busy.statusCode).toBe(503);
    // (The global 120/min limiter still stamps its own x-ratelimit-*
    // headers on every response, busy or not; only the per-user 30/hour
    // quota below -- charged by the route handler itself -- is what must
    // stay untouched by a busy rejection.)

    releaseFirst.resolve();
    const firstResponse = await first;
    expect(firstResponse.statusCode).toBe(200);
    const firstRemaining = Number(
      firstResponse.headers["x-ratelimit-remaining"],
    );

    const secondCall = await app.inject({
      method: "POST",
      url: "/v1/card-lookups",
      headers: authHeaders,
      payload: { imageDataUrl },
    });
    expect(secondCall.statusCode).toBe(200);
    // Only two lookups were ever actually charged (the busy one was not),
    // so the quota drops by exactly one more unit.
    expect(Number(secondCall.headers["x-ratelimit-remaining"])).toBe(
      firstRemaining - 1,
    );
  });
});
