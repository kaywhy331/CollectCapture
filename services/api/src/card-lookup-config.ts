import { z } from "zod";

const OptionalUrlSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().url().optional(),
);

const OptionalSecretSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(20).optional(),
);

const CardLookupEnvironmentSchema = z
  .object({
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    // Absent (the default) means exactly today's behavior: no telemetry is
    // initialized at all (G12b), matching initializeTelemetry's own
    // "no endpoint -> disabled" contract.
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z
      .string()
      .trim()
      .min(1)
      .default("collectcapture-card-lookups"),
    OTEL_EXPORT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(60_000),
    CARD_RECOGNITION_PROVIDER: z
      .enum(["openai", "ollama", "groq"])
      .default("openai"),
    OPENAI_API_KEY: OptionalSecretSchema,
    OPENAI_MODEL: z.string().trim().min(1).default("gpt-5.6"),
    OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
    OLLAMA_API_KEY: OptionalSecretSchema,
    OLLAMA_MODEL: z.string().trim().min(1).default("qwen3.5:4b"),
    OLLAMA_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(120_000),
    GROQ_API_KEY: OptionalSecretSchema,
    GROQ_MODEL: z.string().trim().min(1).default("qwen/qwen3.6-27b"),
    GROQ_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(60_000),
    GROQ_REASONING_EFFORT: z.string().trim().default("none"),
    GROQ_RESPONSE_FORMAT: z
      .enum(["json_object", "json_schema"])
      .default("json_object"),
    GROQ_MAX_COMPLETION_TOKENS: z.coerce
      .number()
      .int()
      .min(1)
      .max(32_768)
      .default(2_048),
    COLLECTFOLIO_APP_URL: z.string().url(),
    COLLECTFOLIO_SUPABASE_URL: z.string().url(),
    COLLECTFOLIO_SUPABASE_JWKS_URL: OptionalUrlSchema,
    COLLECTFOLIO_CATALOG_URL: z.string().url(),
    TRUSTED_PROXY_MODE: z.enum(["none", "cloudflare-tunnel"]).default("none"),
    CARD_LOOKUP_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  })
  .strip()
  .superRefine((value, context) => {
    if (value.CARD_RECOGNITION_PROVIDER === "openai" && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message:
          "OPENAI_API_KEY is required when CARD_RECOGNITION_PROVIDER=openai",
      });
    }
    if (value.CARD_RECOGNITION_PROVIDER === "groq" && !value.GROQ_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["GROQ_API_KEY"],
        message: "GROQ_API_KEY is required when CARD_RECOGNITION_PROVIDER=groq",
      });
    }

    const ollamaUrl = URL.canParse(value.OLLAMA_BASE_URL)
      ? new URL(value.OLLAMA_BASE_URL)
      : null;
    if (ollamaUrl && !["http:", "https:"].includes(ollamaUrl.protocol)) {
      context.addIssue({
        code: "custom",
        path: ["OLLAMA_BASE_URL"],
        message: "The Ollama URL must use HTTP or HTTPS",
      });
    }
    if (
      ollamaUrl?.protocol === "http:" &&
      ![
        "localhost",
        "127.0.0.1",
        "[::1]",
        "host.docker.internal",
        "ollama",
      ].includes(ollamaUrl.hostname)
    ) {
      context.addIssue({
        code: "custom",
        path: ["OLLAMA_BASE_URL"],
        message: "The Ollama URL must use HTTPS outside the local machine",
      });
    }
    if (
      ollamaUrl &&
      (ollamaUrl.username ||
        ollamaUrl.password ||
        ollamaUrl.search ||
        ollamaUrl.hash ||
        (ollamaUrl.pathname !== "/" && ollamaUrl.pathname !== ""))
    ) {
      context.addIssue({
        code: "custom",
        path: ["OLLAMA_BASE_URL"],
        message:
          "The Ollama URL must be an origin without credentials, a path, query, or fragment",
      });
    }
    if (
      value.CARD_RECOGNITION_PROVIDER === "ollama" &&
      ollamaUrl?.hostname === "ollama.com" &&
      !value.OLLAMA_API_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["OLLAMA_API_KEY"],
        message: "OLLAMA_API_KEY is required for direct Ollama Cloud access",
      });
    }

    for (const [field, configured] of [
      ["COLLECTFOLIO_APP_URL", value.COLLECTFOLIO_APP_URL],
      ["COLLECTFOLIO_SUPABASE_URL", value.COLLECTFOLIO_SUPABASE_URL],
      ["COLLECTFOLIO_SUPABASE_JWKS_URL", value.COLLECTFOLIO_SUPABASE_JWKS_URL],
      ["COLLECTFOLIO_CATALOG_URL", value.COLLECTFOLIO_CATALOG_URL],
    ] as const) {
      if (!configured) continue;
      const url = new URL(configured);
      if (
        url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(
            url.hostname,
          )
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            "CollectFolio integration URLs must use HTTPS outside localhost",
        });
      }
      if (url.username || url.password || url.hash) {
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            "CollectFolio integration URLs must not contain credentials or fragments",
        });
      }
    }

    const appUrl = new URL(value.COLLECTFOLIO_APP_URL);
    if (appUrl.pathname !== "/" || appUrl.search) {
      context.addIssue({
        code: "custom",
        path: ["COLLECTFOLIO_APP_URL"],
        message: "The CollectFolio app URL must be an exact origin",
      });
    }

    for (const [field, configured] of [
      ["COLLECTFOLIO_SUPABASE_URL", value.COLLECTFOLIO_SUPABASE_URL],
      ["COLLECTFOLIO_CATALOG_URL", value.COLLECTFOLIO_CATALOG_URL],
    ] as const) {
      if (new URL(configured).search) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "CollectFolio service base URLs must not contain a query",
        });
      }
    }
  });

export type CardLookupConfig = z.infer<typeof CardLookupEnvironmentSchema>;
export type TrustedProxyMode = CardLookupConfig["TRUSTED_PROXY_MODE"];

export function readCardLookupConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CardLookupConfig {
  return CardLookupEnvironmentSchema.parse(environment);
}
