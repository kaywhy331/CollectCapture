import { z } from "zod";

const EnvironmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().trim().min(1).default("localclear-api"),
    OTEL_EXPORT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(60_000),
    DATABASE_URL: z.string().url(),
    SUPABASE_URL: z.string().url(),
    SUPABASE_JWT_SECRET: z.string().min(32),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(32).optional(),
    OPENAI_API_KEY: z.string().min(20).optional(),
    OPENAI_MODEL: z.string().trim().min(1).default("gpt-5.6"),
    AI_MEDIA_BUCKET: z.string().trim().min(1).default("item-media"),
    DEVICE_COMMAND_SIGNING_PRIVATE_KEY: z.string().min(1).optional(),
    DEVICE_COMMAND_SIGNING_KEY_ID: z.string().min(1).default("default"),
    ACCOUNT_DELETION_HASH_KEY: z.string().min(32).optional(),
    PUBLIC_APP_URL: z.string().url(),
    PUBLIC_ADMIN_URL: z.string().url().optional(),
    PUBLIC_API_URL: z.string().url(),
  })
  .strip()
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === "production" &&
      !value.DEVICE_COMMAND_SIGNING_PRIVATE_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["DEVICE_COMMAND_SIGNING_PRIVATE_KEY"],
        message: "A device command signing key is required in production",
      });
    }
    if (value.NODE_ENV === "production" && !value.ACCOUNT_DELETION_HASH_KEY) {
      context.addIssue({
        code: "custom",
        path: ["ACCOUNT_DELETION_HASH_KEY"],
        message:
          "An account-deletion receipt hash key is required in production",
      });
    }
    if (value.NODE_ENV === "production" && !value.PUBLIC_ADMIN_URL) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_ADMIN_URL"],
        message: "The admin console origin is required in production",
      });
    }
    if (value.NODE_ENV === "production" && !value.OTEL_EXPORTER_OTLP_ENDPOINT) {
      context.addIssue({
        code: "custom",
        path: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
        message: "An OTLP telemetry collector is required in production",
      });
    }
    if (
      value.NODE_ENV === "production" &&
      (!value.OPENAI_API_KEY || !value.SUPABASE_SERVICE_ROLE_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message:
          "OpenAI and Supabase service credentials are required in production",
      });
    }
    if (
      Boolean(value.OPENAI_API_KEY) !== Boolean(value.SUPABASE_SERVICE_ROLE_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message:
          "OpenAI and Supabase service credentials must be configured together",
      });
    }
  });

export type AppConfig = z.infer<typeof EnvironmentSchema>;

export function readConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return EnvironmentSchema.parse(environment);
}
