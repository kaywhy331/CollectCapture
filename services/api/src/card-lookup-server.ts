import {
  buildCardLookupApp,
  createCardLookupRuntime,
} from "./card-lookup-app.js";
import { readCardLookupConfig } from "./card-lookup-config.js";
import { REDACTED_LOG_PATHS } from "./observability.js";

const config = readCardLookupConfig();
const sharedRuntimeOptions = {
  collectFolioSupabaseUrl: config.COLLECTFOLIO_SUPABASE_URL,
  ...(config.COLLECTFOLIO_SUPABASE_JWKS_URL
    ? {
        collectFolioSupabaseJwksUrl: config.COLLECTFOLIO_SUPABASE_JWKS_URL,
      }
    : {}),
  collectFolioCatalogUrl: config.COLLECTFOLIO_CATALOG_URL,
};
const runtime =
  config.CARD_RECOGNITION_PROVIDER === "ollama"
    ? createCardLookupRuntime({
        ...sharedRuntimeOptions,
        recognitionProvider: "ollama",
        ollamaBaseUrl: config.OLLAMA_BASE_URL,
        ...(config.OLLAMA_API_KEY
          ? { ollamaApiKey: config.OLLAMA_API_KEY }
          : {}),
        ollamaModel: config.OLLAMA_MODEL,
        ollamaTimeoutMs: config.OLLAMA_TIMEOUT_MS,
      })
    : config.CARD_RECOGNITION_PROVIDER === "groq"
      ? createCardLookupRuntime({
          ...sharedRuntimeOptions,
          recognitionProvider: "groq",
          groqApiKey: config.GROQ_API_KEY!,
          groqModel: config.GROQ_MODEL,
          groqTimeoutMs: config.GROQ_TIMEOUT_MS,
          groqReasoningEffort: config.GROQ_REASONING_EFFORT,
          groqResponseFormat: config.GROQ_RESPONSE_FORMAT,
          groqMaxCompletionTokens: config.GROQ_MAX_COMPLETION_TOKENS,
        })
      : createCardLookupRuntime({
          ...sharedRuntimeOptions,
          recognitionProvider: "openai",
          openAIApiKey: config.OPENAI_API_KEY!,
          openAIModel: config.OPENAI_MODEL,
        });
const app = await buildCardLookupApp({
  ...runtime,
  allowedOrigin: new URL(config.COLLECTFOLIO_APP_URL).origin,
  trustedProxyMode: config.TRUSTED_PROXY_MODE,
  maxConcurrentVisionLookups: config.CARD_LOOKUP_MAX_CONCURRENCY,
  logger: {
    level: config.LOG_LEVEL,
    redact: {
      paths: [...REDACTED_LOG_PATHS],
      censor: "[REDACTED]",
    },
  },
});

let closing = false;
const close = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "Shutting down CollectCapture card lookup service");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal(
    { err: error },
    "CollectCapture card lookup service failed to start",
  );
  await app.close();
  process.exit(1);
}
