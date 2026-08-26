import {
  CardLookupResultSchema,
  CardRecognitionSchema,
} from "@localclear/domain";
import { createHash } from "node:crypto";
import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { buildApp } from "../src/app.js";
import {
  ClientDisconnectedError,
  GroqCardRecognitionProvider,
  OllamaCardRecognitionProvider,
  OpenAICardRecognitionProvider,
  StatelessCardLookupService,
  TcgcsvCardCatalogProvider,
  normalizedNumber,
  type CardCatalogProvider,
  type CardLookupHandler,
  type CardRecognitionProvider,
} from "../src/card-lookups.js";
import { StaticTokenVerifier } from "../src/auth.js";
import { MemoryRepository } from "../src/memory-repository.js";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const imageDataUrl = `data:image/png;base64,${pngBase64}`;

const recognition = CardRecognitionSchema.parse({
  source: "vision",
  category: "pokemon",
  name: "Charizard ex",
  setName: "Obsidian Flames",
  collectorNumber: "223/197",
  language: "en",
  visibleText: ["Charizard ex", "223/197"],
  queries: ["Charizard ex 223/197", "Charizard ex"],
  confidence: 0.91,
  provider: "test-vision",
  model: "deterministic-v1",
});

const candidate = {
  id: "tcgcsv:3:123:456",
  externalId: "3:123:456",
  provider: "tcgcsv",
  category: "tcgcsv-category-3",
  game: "Pokemon",
  name: "Charizard ex",
  setName: "Obsidian Flames",
  setCode: "OBF",
  number: "223/197",
  variant: "Holofoil",
  rarity: "Special Illustration Rare",
  year: "2023",
  image: "https://tcgplayer-cdn.tcgplayer.com/product/456_in_1000x1000.jpg",
  imageSmall: "https://tcgplayer-cdn.tcgplayer.com/product/456_in_400x400.jpg",
  price: null,
  priceOptions: [],
  currency: "USD",
  priceSource: "",
  priceUrl: "",
  priceUpdatedAt: "",
  matchBucket: "likely",
  matchScore: 0.99,
  categoryId: 3,
  groupId: 123,
  productId: 456,
} as const;

describe("OpenAI card recognition", () => {
  it("uses structured output without storing response application state", async () => {
    const parse = vi.fn(async () => ({
      output_parsed: {
        category: "pokemon",
        name: "Charizard ex",
        setName: "Obsidian Flames",
        collectorNumber: "223/197",
        language: "en",
        visibleText: ["Charizard ex", "223/197"],
        queries: ["Charizard ex 223/197"],
        confidence: 0.91,
      },
    }));
    const provider = new OpenAICardRecognitionProvider({
      model: "deterministic-v1",
      client: { responses: { parse } } as unknown as OpenAI,
    });

    await expect(
      provider.recognize({ imageDataUrl, categoryHint: "all" }),
    ).resolves.toMatchObject({ source: "vision", name: "Charizard ex" });
    expect(parse).toHaveBeenCalledWith(
      expect.objectContaining({ store: false, model: "deterministic-v1" }),
      expect.objectContaining({ signal: undefined }),
    );
  });
});

describe("Ollama card recognition", () => {
  it("sends a base64 vision request with a strict structured-output schema", async () => {
    let requestedUrl = "";
    let authorization = "";
    let requestBody: Record<string, any> = {};
    const provider = new OllamaCardRecognitionProvider({
      baseUrl: "https://ollama.com",
      apiKey: "ollama-cloud-test-key",
      model: "qwen3.5:397b",
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            message: {
              role: "assistant",
              content: JSON.stringify({
                category: "pokemon",
                name: "Charizard ex",
                setName: "Obsidian Flames",
                collectorNumber: "223/197",
                language: "en",
                visibleText: ["Charizard ex", "223/197"],
                queries: ["Charizard ex 223/197"],
                confidence: 0.91,
              }),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(
      provider.recognize({ imageDataUrl, categoryHint: "pokemon" }),
    ).resolves.toMatchObject({
      source: "vision",
      provider: "ollama",
      model: "qwen3.5:397b",
      name: "Charizard ex",
    });
    expect(requestedUrl).toBe("https://ollama.com/api/chat");
    expect(authorization).toBe("Bearer ollama-cloud-test-key");
    expect(requestBody).toMatchObject({
      model: "qwen3.5:397b",
      stream: false,
      keep_alive: -1,
      options: { temperature: 0 },
      messages: [
        { role: "system" },
        {
          role: "user",
          content: expect.stringContaining("pokemon"),
          images: [pngBase64],
        },
      ],
      format: {
        type: "object",
        additionalProperties: false,
        required: expect.arrayContaining([
          "category",
          "name",
          "collectorNumber",
          "queries",
        ]),
      },
    });
  });

  it("maps malformed model output to the existing safe provider error", async () => {
    const provider = new OllamaCardRecognitionProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-vl:4b",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ message: { content: "not valid json" } }),
        ),
    });

    await expect(
      provider.recognize({ imageDataUrl, categoryHint: "all" }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "card_recognition_failed",
      message: "CollectCapture could not recognize this card image",
    });
  });

  it("rejects an Ollama URL that could redirect recognition requests", () => {
    expect(
      () =>
        new OllamaCardRecognitionProvider({
          baseUrl: "http://ollama:11434/unreviewed/path",
          model: "qwen3-vl:4b",
        }),
    ).toThrow("must be an origin");
    expect(
      () =>
        new OllamaCardRecognitionProvider({
          baseUrl: "http://remote-ollama.example.test",
          model: "qwen3.5:4b",
        }),
    ).toThrow("must use HTTPS outside the local machine");
  });
});

describe("Groq card recognition", () => {
  it("uses the current vision chat endpoint with JSON mode and local validation", async () => {
    let requestedUrl = "";
    let authorization = "";
    let requestBody: Record<string, any> = {};
    const provider = new GroqCardRecognitionProvider({
      apiKey: "groq-test-key",
      model: "qwen/qwen3.6-27b",
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    category: "magic",
                    name: "Black Lotus",
                    setName: null,
                    collectorNumber: null,
                    language: "en",
                    visibleText: ["Black Lotus"],
                    queries: ["Black Lotus"],
                    confidence: 0.88,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      provider.recognize({ imageDataUrl, categoryHint: "magic" }),
    ).resolves.toMatchObject({
      provider: "groq",
      model: "qwen/qwen3.6-27b",
      name: "Black Lotus",
    });
    expect(requestedUrl).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect(authorization).toBe("Bearer groq-test-key");
    expect(requestBody).toMatchObject({
      model: "qwen/qwen3.6-27b",
      stream: false,
      temperature: 0,
      reasoning_effort: "none",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: expect.stringMatching(/magic[\s\S]+JSON Schema/),
            },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    });
  });

  it("sends the configured reasoning effort for a non-default model name", async () => {
    let requestBody: Record<string, any> = {};
    const provider = new GroqCardRecognitionProvider({
      apiKey: "groq-test-key",
      model: "llama-4-scout-17b",
      reasoningEffort: "low",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    category: "magic",
                    name: "Black Lotus",
                    setName: null,
                    collectorNumber: null,
                    language: "en",
                    visibleText: ["Black Lotus"],
                    queries: ["Black Lotus"],
                    confidence: 0.88,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      provider.recognize({ imageDataUrl, categoryHint: "magic" }),
    ).resolves.toMatchObject({ provider: "groq", model: "llama-4-scout-17b" });
    expect(requestBody).toMatchObject({
      model: "llama-4-scout-17b",
      reasoning_effort: "low",
    });
  });

  it("omits reasoning_effort when the configured value is empty", async () => {
    let requestBody: Record<string, any> = {};
    const provider = new GroqCardRecognitionProvider({
      apiKey: "groq-test-key",
      model: "llama-4-scout-17b",
      reasoningEffort: "",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    category: "magic",
                    name: "Black Lotus",
                    setName: null,
                    collectorNumber: null,
                    language: "en",
                    visibleText: ["Black Lotus"],
                    queries: ["Black Lotus"],
                    confidence: 0.88,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await provider.recognize({ imageDataUrl, categoryHint: "magic" });
    expect(requestBody).not.toHaveProperty("reasoning_effort");
  });
});

describe("normalizedNumber", () => {
  it("strips a leading zero from every digit run, not just the string start", () => {
    expect(normalizedNumber("SV004")).toBe(normalizedNumber("SV4"));
    expect(normalizedNumber("004/198")).toBe(normalizedNumber("4/198"));
    expect(normalizedNumber("4/098")).toBe(normalizedNumber("4/98"));
  });

  it("does not treat a value ending in zero as equal to that value without it", () => {
    expect(normalizedNumber("10")).not.toBe(normalizedNumber("1"));
  });
});

describe("stateless card lookup", () => {
  it("verifies a metadata-free crop and discloses that it was not retained", async () => {
    const recognize = vi.fn(async () => recognition);
    const search = vi.fn(async () => ({
      candidates: [candidate],
      warnings: [],
    }));
    const service = new StatelessCardLookupService(
      {
        providerName: "test-vision",
        model: "deterministic-v1",
        recognize,
      } satisfies CardRecognitionProvider,
      { search } satisfies CardCatalogProvider,
    );

    const result = await service.lookup(
      { imageDataUrl, query: "", category: "all", limit: 12 },
      { authorization: "Bearer folio-token" },
    );

    expect(result).toMatchObject({
      imageRetained: false,
      recognition: { name: "Charizard ex" },
      candidates: [{ externalId: "3:123:456" }],
    });
    expect(result.contentSha256).toBe(
      createHash("sha256")
        .update(Buffer.from(pngBase64, "base64"))
        .digest("hex"),
    );
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: "Bearer folio-token",
        category: "pokemon",
      }),
    );
  }, 15_000);

  it("uses an edited collector query without paying for another vision call", async () => {
    const recognize = vi.fn(async () => recognition);
    const search = vi.fn(async (input) => {
      expect(input.recognition).toMatchObject({
        source: "user_query",
        queries: ["Black Lotus LEA"],
      });
      return { candidates: [], warnings: [] };
    });
    const service = new StatelessCardLookupService(
      {
        providerName: "test-vision",
        model: "deterministic-v1",
        recognize,
      },
      { search },
    );

    await service.lookup(
      {
        imageDataUrl,
        query: "Black Lotus LEA",
        category: "magic",
        limit: 8,
      },
      { authorization: "Bearer folio-token" },
    );

    expect(recognize).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ category: "magic", limit: 8 }),
    );
  });

  it("validates unknown input through the explicit unvalidated entry point", async () => {
    const service = new StatelessCardLookupService(
      {
        providerName: "test-vision",
        model: "deterministic-v1",
        async recognize() {
          return recognition;
        },
      },
      {
        async search() {
          return { candidates: [candidate], warnings: [] };
        },
      },
    );

    await expect(
      service.lookupUnvalidated(
        { imageDataUrl, category: "pokemon" },
        { authorization: "Bearer folio-token" },
      ),
    ).resolves.toMatchObject({ imageRetained: false });

    await expect(
      service.lookupUnvalidated(
        { imageDataUrl, category: "not-a-real-category" },
        { authorization: "Bearer folio-token" },
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects image bytes that do not match their declared media type", async () => {
    const service = new StatelessCardLookupService(
      {
        providerName: "test-vision",
        model: "deterministic-v1",
        async recognize() {
          return recognition;
        },
      },
      {
        async search() {
          return { candidates: [], warnings: [] };
        },
      },
    );

    await expect(
      service.lookup(
        {
          imageDataUrl: `data:image/jpeg;base64,${pngBase64}`,
          query: "",
          category: "all",
          limit: 12,
        },
        { authorization: "Bearer folio-token" },
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "media_type_mismatch" });
  });
});

describe("client disconnect cancellation", () => {
  it("aborts an in-flight provider call and never enters the catalog phase (mid-flight abort)", async () => {
    const controller = new AbortController();
    let providerObservedAbort = false;
    const recognize = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => {
            providerObservedAbort = true;
            reject(new Error("provider fetch aborted"));
          });
        }),
    );
    const search = vi.fn(async () => ({ candidates: [], warnings: [] }));
    const service = new StatelessCardLookupService(
      { providerName: "test-vision", model: "deterministic-v1", recognize },
      { search },
    );

    const lookup = service.lookup(
      { imageDataUrl, query: "", category: "all", limit: 12 },
      { authorization: "Bearer folio-token", signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);

    await expect(lookup).rejects.toBeInstanceOf(ClientDisconnectedError);
    expect(providerObservedAbort).toBe(true);
    expect(search).not.toHaveBeenCalled();
  }, 5_000);

  it("never enters the catalog phase when the signal is already aborted before the lookup begins", async () => {
    const controller = new AbortController();
    controller.abort();
    const recognize = vi.fn(async () => recognition);
    const search = vi.fn(async () => ({ candidates: [], warnings: [] }));
    const service = new StatelessCardLookupService(
      { providerName: "test-vision", model: "deterministic-v1", recognize },
      { search },
    );

    await expect(
      service.lookup(
        { imageDataUrl, query: "", category: "all", limit: 12 },
        { authorization: "Bearer folio-token", signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(ClientDisconnectedError);
    expect(recognize).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("threads the signal into the real Ollama fetch call", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const provider = new OllamaCardRecognitionProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-vl:4b",
      fetchImpl: (_input, init) => {
        observedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      },
    });

    const recognizePromise = provider.recognize({
      imageDataUrl,
      categoryHint: "all",
      signal: controller.signal,
    });
    controller.abort();

    await expect(recognizePromise).rejects.toMatchObject({
      statusCode: 502,
      code: "card_recognition_failed",
    });
    expect(observedSignal?.aborted).toBe(true);
  }, 5_000);
});

describe("TCGCSV catalog lookup", () => {
  it("allows Docker Desktop's host gateway for a local catalog", () => {
    expect(
      () =>
        new TcgcsvCardCatalogProvider({
          baseUrl: "http://host.docker.internal:8787",
        }),
    ).not.toThrow();
  });

  it("rejects catalog base URLs that could misdirect the bearer token", () => {
    expect(
      () =>
        new TcgcsvCardCatalogProvider({
          baseUrl: "https://user:password@catalog.example.test",
        }),
    ).toThrow("must not contain credentials");
  });

  it("forwards the user session and returns bounded identity-only candidates", async () => {
    const requests: URL[] = [];
    const provider = new TcgcsvCardCatalogProvider({
      baseUrl: "https://catalog.example.test",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer folio-token",
        );
        return new Response(
          JSON.stringify({
            products: [
              {
                categoryId: 3,
                categoryName: "Pokemon",
                groupId: 123,
                groupName: "Obsidian Flames",
                groupAbbreviation: "OBF",
                groupPublishedOn: "2023-08-11",
                productId: 456,
                name: "Charizard ex",
                cardNumber: "223/197",
                rarity: "Special Illustration Rare",
                prices: [{ subtypeName: "Holofoil", marketPrice: 99 }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await provider.search({
      recognition,
      category: "pokemon",
      limit: 12,
      authorization: "Bearer folio-token",
    });

    expect(requests).toHaveLength(4);
    expect(requests.map((url) => url.searchParams.get("category_id"))).toEqual([
      "3",
      "85",
      "3",
      "85",
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      externalId: "3:123:456",
      matchBucket: "likely",
      price: null,
      priceOptions: [],
    });
  });

  it("cancels an undeclared catalog response as soon as it exceeds its byte limit", async () => {
    const chunk = new Uint8Array(3 * 1024 * 1024).fill(0x20);
    let pulls = 0;
    let cancelled = false;
    const provider = new TcgcsvCardCatalogProvider({
      baseUrl: "https://catalog.example.test",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls += 1;
                controller.enqueue(chunk);
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(
      provider.search({
        recognition: CardRecognitionSchema.parse({
          ...recognition,
          queries: ["Charizard"],
        }),
        category: "other",
        limit: 12,
        authorization: "Bearer folio-token",
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "card_catalog_unavailable",
    });
    expect(pulls).toBe(3);
    expect(cancelled).toBe(true);
  });
});

describe("card lookup route", () => {
  it("uses the CollectFolio verifier rather than the core application verifier", async () => {
    const repository = new MemoryRepository();
    const lookup = CardLookupResultSchema.parse({
      contentSha256: "a".repeat(64),
      imageRetained: false,
      recognition,
      candidates: [candidate],
      warnings: [],
    });
    const service: CardLookupHandler = {
      async lookup(_request, context) {
        expect(context.authorization).toBe("Bearer folio-token");
        return lookup;
      },
    };
    const app = await buildApp({
      repository,
      tokenVerifier: new StaticTokenVerifier(
        new Map([["core-token", { userId: "core", email: null, roles: [] }]]),
      ),
      cardLookupTokenVerifier: new StaticTokenVerifier(
        new Map([["folio-token", { userId: "folio", email: null, roles: [] }]]),
      ),
      cardLookupService: service,
    });
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: "/v1/card-lookups",
        payload: { imageDataUrl },
      });
      expect(unauthorized.statusCode).toBe(401);

      const wrongIssuer = await app.inject({
        method: "POST",
        url: "/v1/card-lookups",
        headers: { authorization: "Bearer core-token" },
        payload: { imageDataUrl },
      });
      expect(wrongIssuer.statusCode).toBe(401);

      const accepted = await app.inject({
        method: "POST",
        url: "/v1/card-lookups",
        headers: { authorization: "Bearer folio-token" },
        payload: { imageDataUrl },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.headers["cache-control"]).toBe("no-store");
      expect(accepted.headers.pragma).toBe("no-cache");
      expect(accepted.json().lookup).toMatchObject({ imageRetained: false });
    } finally {
      await app.close();
    }
  });

  it("limits card lookups per authenticated CollectFolio principal", async () => {
    const lookup = CardLookupResultSchema.parse({
      contentSha256: "a".repeat(64),
      imageRetained: false,
      recognition,
      candidates: [candidate],
      warnings: [],
    });
    const app = await buildApp({
      repository: new MemoryRepository(),
      tokenVerifier: new StaticTokenVerifier(new Map()),
      cardLookupTokenVerifier: new StaticTokenVerifier(
        new Map([
          ["folio-token-a", { userId: "folio-a", email: null, roles: [] }],
          ["folio-token-b", { userId: "folio-b", email: null, roles: [] }],
        ]),
      ),
      cardLookupService: {
        async lookup() {
          return lookup;
        },
      },
    });
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const accepted = await app.inject({
          method: "POST",
          url: "/v1/card-lookups",
          headers: { authorization: "Bearer folio-token-a" },
          payload: { imageDataUrl },
        });
        expect(accepted.statusCode).toBe(200);
      }

      const limited = await app.inject({
        method: "POST",
        url: "/v1/card-lookups",
        headers: { authorization: "Bearer folio-token-a" },
        payload: { imageDataUrl },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: "rate_limited" });

      const otherPrincipal = await app.inject({
        method: "POST",
        url: "/v1/card-lookups",
        headers: { authorization: "Bearer folio-token-b" },
        payload: { imageDataUrl },
      });
      expect(otherPrincipal.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("does not expose the route or reuse core auth when the integration is absent", async () => {
    const app = await buildApp({
      repository: new MemoryRepository(),
      tokenVerifier: new StaticTokenVerifier(
        new Map([["core-token", { userId: "core", email: null, roles: [] }]]),
      ),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/card-lookups",
        headers: { authorization: "Bearer core-token" },
        payload: { imageDataUrl },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects a partially configured lookup boundary at startup", async () => {
    await expect(
      buildApp({
        repository: new MemoryRepository(),
        tokenVerifier: new StaticTokenVerifier(new Map()),
        cardLookupService: {
          async lookup() {
            throw new Error("not called");
          },
        },
      }),
    ).rejects.toThrow("verifier and service must be configured together");
  });
});
