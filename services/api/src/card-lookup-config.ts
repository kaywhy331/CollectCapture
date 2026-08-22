import { z } from "zod";

const OptionalUrlSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().url().optional(),
);

const CardLookupEnvironmentSchema = z
  .object({
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    OPENAI_API_KEY: z.string().min(20),
    OPENAI_MODEL: z.string().trim().min(1).default("gpt-5.6"),
    COLLECTFOLIO_APP_URL: z.string().url(),
    COLLECTFOLIO_SUPABASE_URL: z.string().url(),
    COLLECTFOLIO_SUPABASE_JWKS_URL: OptionalUrlSchema,
    COLLECTFOLIO_CATALOG_URL: z.string().url(),
  })
  .strip()
  .superRefine((value, context) => {
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
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
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

export function readCardLookupConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CardLookupConfig {
  return CardLookupEnvironmentSchema.parse(environment);
}
