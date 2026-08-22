import { CardLookupResultSchema } from "@localclear/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCardLookupApp } from "../src/card-lookup-app.js";
import { readCardLookupConfig } from "../src/card-lookup-config.js";
import { StaticTokenVerifier } from "../src/auth.js";

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
      OPENAI_MODEL: "gpt-5.6",
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
  });
});
