import { buildApp } from "./app.js";
import {
  OpenAICardRecognitionProvider,
  StatelessCardLookupService,
  TcgcsvCardCatalogProvider,
} from "./card-lookups.js";
import { LocalClearApplication } from "./application.js";
import { SupabaseAccountLifecycleProvider } from "./account-lifecycle.js";
import { JwksTokenVerifier, SharedSecretTokenVerifier } from "./auth.js";
import { readConfig } from "./config.js";
import { SignedDeviceCommandFactory } from "./device-commands.js";
import { OpenAIIntelligenceProvider } from "./intelligence.js";
import {
  ExpoPushDeliveryProvider,
  NotificationDispatcher,
} from "./notification-dispatcher.js";
import { initializeTelemetry, REDACTED_LOG_PATHS } from "./observability.js";
import { PostgresRepository } from "./postgres-repository.js";
import { PublishingDispatcher } from "./publishing-dispatcher.js";
import { RetentionDispatcher } from "./retention-dispatcher.js";
import { GovernedServerConnectorExecutor } from "./server-connectors.js";
import { seedMissingConnectors } from "./seed-connectors.js";
import { seedMissingFeatureFlags } from "./seed-feature-flags.js";
import { SupabaseMediaReadUrlProvider } from "./supabase-media.js";

const config = readConfig();
const telemetry = initializeTelemetry({
  endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  serviceName: config.OTEL_SERVICE_NAME,
  serviceVersion: "0.1.0",
  environment: config.NODE_ENV,
  exportIntervalMs: config.OTEL_EXPORT_INTERVAL_MS,
});
const repository = new PostgresRepository(config.DATABASE_URL);
const mediaReadUrlProvider = config.SUPABASE_SERVICE_ROLE_KEY
  ? new SupabaseMediaReadUrlProvider({
      url: config.SUPABASE_URL,
      serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
      bucket: config.AI_MEDIA_BUCKET,
    })
  : null;
const accountLifecycleProvider = config.SUPABASE_SERVICE_ROLE_KEY
  ? new SupabaseAccountLifecycleProvider({
      url: config.SUPABASE_URL,
      serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
      bucket: config.AI_MEDIA_BUCKET,
    })
  : null;
const intelligence =
  config.OPENAI_API_KEY && mediaReadUrlProvider
    ? {
        intelligenceProvider: new OpenAIIntelligenceProvider({
          apiKey: config.OPENAI_API_KEY,
          model: config.OPENAI_MODEL,
        }),
        mediaReadUrlProvider,
      }
    : {};
const deviceCommands =
  config.DEVICE_COMMAND_SIGNING_PRIVATE_KEY && mediaReadUrlProvider
    ? {
        deviceCommandFactory: new SignedDeviceCommandFactory({
          keyId: config.DEVICE_COMMAND_SIGNING_KEY_ID,
          privateKey: config.DEVICE_COMMAND_SIGNING_PRIVATE_KEY,
          mediaReadUrlProvider,
        }),
      }
    : {};

const application = new LocalClearApplication(repository, {
  environment: config.NODE_ENV === "production" ? "production" : "internal",
  apiBaseUrl: config.PUBLIC_API_URL,
  ...(mediaReadUrlProvider
    ? { mediaVerificationProvider: mediaReadUrlProvider }
    : {}),
  ...intelligence,
  ...deviceCommands,
  ...(accountLifecycleProvider
    ? {
        accountIdentityProvider: accountLifecycleProvider,
        mediaLifecycleProvider: accountLifecycleProvider,
      }
    : {}),
  ...(config.ACCOUNT_DELETION_HASH_KEY
    ? { accountDeletionHashKey: config.ACCOUNT_DELETION_HASH_KEY }
    : {}),
});

await seedMissingConnectors(repository);
await seedMissingFeatureFlags(repository);

const issuer = new URL("/auth/v1", config.SUPABASE_URL)
  .toString()
  .replace(/\/$/, "");
const tokenVerifier =
  config.SUPABASE_JWT_VERIFICATION_MODE === "jwks"
    ? new JwksTokenVerifier({
        jwksUrl: new URL(
          config.SUPABASE_JWKS_URL ?? `${issuer}/.well-known/jwks.json`,
        ),
        issuer,
        audience: "authenticated",
      })
    : new SharedSecretTokenVerifier({
        secret: config.SUPABASE_JWT_SECRET!,
        issuer,
        audience: "authenticated",
      });
const cardLookupIntegration =
  config.COLLECTFOLIO_APP_URL &&
  config.COLLECTFOLIO_SUPABASE_URL &&
  config.COLLECTFOLIO_CATALOG_URL &&
  config.OPENAI_API_KEY
    ? (() => {
        const collectFolioIssuer = new URL(
          "/auth/v1",
          config.COLLECTFOLIO_SUPABASE_URL,
        )
          .toString()
          .replace(/\/$/, "");
        return {
          tokenVerifier: new JwksTokenVerifier({
            jwksUrl: new URL(
              config.COLLECTFOLIO_SUPABASE_JWKS_URL ??
                `${collectFolioIssuer}/.well-known/jwks.json`,
            ),
            issuer: collectFolioIssuer,
            audience: "authenticated",
          }),
          service: new StatelessCardLookupService(
            new OpenAICardRecognitionProvider({
              apiKey: config.OPENAI_API_KEY,
              model: config.OPENAI_MODEL,
            }),
            new TcgcsvCardCatalogProvider({
              baseUrl: config.COLLECTFOLIO_CATALOG_URL,
            }),
          ),
        };
      })()
    : null;
const app = await buildApp({
  repository,
  application,
  tokenVerifier,
  ...(cardLookupIntegration
    ? {
        cardLookupTokenVerifier: cardLookupIntegration.tokenVerifier,
        cardLookupService: cardLookupIntegration.service,
      }
    : {}),
  environment: config.NODE_ENV === "production" ? "production" : "internal",
  allowedOrigins: [
    config.PUBLIC_APP_URL,
    config.PUBLIC_ADMIN_URL,
    config.COLLECTFOLIO_APP_URL
      ? new URL(config.COLLECTFOLIO_APP_URL).origin
      : undefined,
  ].filter((value): value is string => Boolean(value)),
  logger: {
    level: config.LOG_LEVEL,
    redact: {
      paths: [...REDACTED_LOG_PATHS],
      censor: "[REDACTED]",
    },
  },
});
app.addHook("onClose", async () => telemetry.shutdown());

const dispatcher = new PublishingDispatcher({
  repository,
  application,
  executor: new GovernedServerConnectorExecutor(),
});
const notificationDispatcher = new NotificationDispatcher({
  repository,
  provider: new ExpoPushDeliveryProvider(),
});
const retentionDispatcher = accountLifecycleProvider
  ? new RetentionDispatcher({
      repository,
      mediaLifecycleProvider: accountLifecycleProvider,
    })
  : null;
let dispatcherRunning = false;
const dispatcherTimer = setInterval(() => {
  if (dispatcherRunning) return;
  dispatcherRunning = true;
  void Promise.allSettled([
    dispatcher.runOnce(),
    notificationDispatcher.runOnce(),
  ])
    .then((results) => {
      const [publishing, notifications] = results;
      if (publishing?.status === "rejected") {
        app.log.error(
          { errorType: errorType(publishing.reason) },
          "Publishing dispatch failed",
        );
      }
      if (notifications?.status === "rejected") {
        app.log.error(
          { errorType: errorType(notifications.reason) },
          "Notification dispatch failed",
        );
      }
    })
    .finally(() => {
      dispatcherRunning = false;
    });
}, 2_000);
dispatcherTimer.unref();
app.addHook("onClose", async () => clearInterval(dispatcherTimer));

let retentionRunning = false;
const runRetention = () => {
  if (!retentionDispatcher || retentionRunning) return;
  retentionRunning = true;
  void retentionDispatcher
    .runOnce()
    .then((purged) => {
      const total = Object.values(purged).reduce(
        (sum, count) => sum + count,
        0,
      );
      if (total > 0) app.log.info({ ...purged }, "Expired data purged");
    })
    .catch((error: unknown) => {
      app.log.error(
        { errorType: errorType(error) },
        "Retention sweep failed closed",
      );
    })
    .finally(() => {
      retentionRunning = false;
    });
};
runRetention();
const retentionTimer = setInterval(runRetention, 5 * 60_000);
retentionTimer.unref();
app.addHook("onClose", async () => clearInterval(retentionTimer));

const close = async (signal: string) => {
  app.log.info({ signal }, "Shutting down LocalClear API");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal({ err: error }, "LocalClear API failed to start");
  await app.close();
  process.exit(1);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
