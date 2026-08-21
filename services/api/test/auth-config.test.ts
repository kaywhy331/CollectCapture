import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { SharedSecretTokenVerifier, StaticTokenVerifier } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { MemoryRepository } from "../src/memory-repository.js";
import { seedInitialConnectors } from "../src/seed-connectors.js";
import { seedInitialFeatureFlags } from "../src/seed-feature-flags.js";

const productionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
  SUPABASE_URL: "https://project.example.test",
  SUPABASE_JWT_VERIFICATION_MODE: "jwks",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-that-is-at-least-32-characters",
  OPENAI_API_KEY: "openai-key-that-is-at-least-20-characters",
  DEVICE_COMMAND_SIGNING_PRIVATE_KEY: "configured-private-key",
  ACCOUNT_DELETION_HASH_KEY:
    "account-deletion-key-that-is-at-least-32-characters",
  PUBLIC_APP_URL: "https://app.example.test",
  PUBLIC_ADMIN_URL: "https://admin.example.test",
  PUBLIC_API_URL: "https://api.example.test",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.example.test",
} satisfies NodeJS.ProcessEnv;

describe("production authentication configuration", () => {
  it("accepts asymmetric JWKS verification without a legacy shared secret", () => {
    const config = readConfig({
      ...productionEnvironment,
      SUPABASE_JWKS_URL: "",
    });
    expect(config.SUPABASE_JWT_VERIFICATION_MODE).toBe("jwks");
    expect(config.SUPABASE_JWKS_URL).toBeUndefined();
    expect(config.SUPABASE_JWT_SECRET).toBeUndefined();
  });

  it("rejects legacy shared-secret verification in production", () => {
    expect(() =>
      readConfig({
        ...productionEnvironment,
        SUPABASE_JWT_VERIFICATION_MODE: "legacy",
        SUPABASE_JWT_SECRET: "legacy-secret-that-is-at-least-32-characters",
      }),
    ).toThrow("Production requires asymmetric JWKS token verification");
  });

  it("preserves the Supabase authentication assurance level", async () => {
    const secret = "test-jwt-secret-that-is-at-least-32-characters";
    const token = await new SignJWT({
      email: "operator@example.test",
      app_metadata: { roles: ["operator"] },
      aal: "aal2",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("operator-user")
      .setIssuer("https://project.example.test/auth/v1")
      .setAudience("authenticated")
      .sign(new TextEncoder().encode(secret));
    const principal = await new SharedSecretTokenVerifier({
      secret,
      issuer: "https://project.example.test/auth/v1",
      audience: "authenticated",
    }).verify(token);
    expect(principal).toMatchObject({
      userId: "operator-user",
      roles: ["operator"],
      authenticationAssuranceLevel: "aal2",
    });
  });

  it("requires aal2 for production operations routes", async () => {
    const repository = new MemoryRepository();
    await seedInitialConnectors((manifest) =>
      repository.upsertConnector(manifest),
    );
    await seedInitialFeatureFlags((flag) => repository.upsertFeatureFlag(flag));
    const app = await buildApp({
      repository,
      environment: "production",
      tokenVerifier: new StaticTokenVerifier(
        new Map([
          [
            "aal1-token",
            {
              userId: "operator-one",
              email: "operator-one@example.test",
              roles: ["operator"],
              authenticationAssuranceLevel: "aal1" as const,
            },
          ],
          [
            "aal2-token",
            {
              userId: "operator-two",
              email: "operator-two@example.test",
              roles: ["operator"],
              authenticationAssuranceLevel: "aal2" as const,
            },
          ],
        ]),
      ),
    });
    try {
      const rejected = await app.inject({
        method: "GET",
        url: "/v1/admin/operations",
        headers: { authorization: "Bearer aal1-token" },
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toMatchObject({ error: "admin_mfa_required" });

      const accepted = await app.inject({
        method: "GET",
        url: "/v1/admin/operations",
        headers: { authorization: "Bearer aal2-token" },
      });
      expect(accepted.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
