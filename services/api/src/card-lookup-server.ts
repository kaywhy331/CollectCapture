import {
  buildCardLookupApp,
  createCardLookupRuntime,
} from "./card-lookup-app.js";
import { readCardLookupConfig } from "./card-lookup-config.js";
import { REDACTED_LOG_PATHS } from "./observability.js";

const config = readCardLookupConfig();
const runtime = createCardLookupRuntime({
  openAIApiKey: config.OPENAI_API_KEY,
  openAIModel: config.OPENAI_MODEL,
  collectFolioSupabaseUrl: config.COLLECTFOLIO_SUPABASE_URL,
  ...(config.COLLECTFOLIO_SUPABASE_JWKS_URL
    ? {
        collectFolioSupabaseJwksUrl: config.COLLECTFOLIO_SUPABASE_JWKS_URL,
      }
    : {}),
  collectFolioCatalogUrl: config.COLLECTFOLIO_CATALOG_URL,
});
const app = await buildCardLookupApp({
  ...runtime,
  allowedOrigin: new URL(config.COLLECTFOLIO_APP_URL).origin,
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
