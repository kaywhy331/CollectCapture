import Fastify from "fastify";
import { errors as joseErrors, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  createAuthenticationHook,
  JWKS_ASYMMETRIC_SIGNING_PRECONDITION,
  JwksTokenVerifier,
  probeJwksEndpoint,
  type JwksProbeLogger,
  type TokenVerifier,
} from "../src/auth.js";

function recordingLogger(): JwksProbeLogger & {
  infoCalls: [Record<string, unknown>, string][];
  warnCalls: [Record<string, unknown>, string][];
} {
  const infoCalls: [Record<string, unknown>, string][] = [];
  const warnCalls: [Record<string, unknown>, string][] = [];
  return {
    infoCalls,
    warnCalls,
    info: (payload, message) => infoCalls.push([payload, message]),
    warn: (payload, message) => warnCalls.push([payload, message]),
  };
}

async function appWithVerifier(verifier: TokenVerifier) {
  const app = Fastify();
  app.addHook("preHandler", createAuthenticationHook(verifier));
  app.get("/protected", async () => ({ ok: true }));
  return app;
}

describe("createAuthenticationHook", () => {
  it("returns 401 when no bearer token is present", async () => {
    const app = await appWithVerifier({
      async verify() {
        throw new Error("should not be called");
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/protected" });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "unauthorized" });
    } finally {
      await app.close();
    }
  });

  it("returns 401 for a genuine token problem (expired, bad signature, unknown key)", async () => {
    for (const error of [
      new joseErrors.JWTExpired("token expired", {}),
      new joseErrors.JWSSignatureVerificationFailed(),
      new joseErrors.JWKSNoMatchingKey(),
      new Error("Unknown test token"),
    ]) {
      const app = await appWithVerifier({
        async verify() {
          throw error;
        },
      });
      try {
        const response = await app.inject({
          method: "GET",
          url: "/protected",
          headers: { authorization: "Bearer whatever" },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: "unauthorized" });
        expect(response.headers["retry-after"]).toBeUndefined();
      } finally {
        await app.close();
      }
    }
  });

  it("returns 503 authentication_unavailable when the JWKS request times out", async () => {
    const app = await appWithVerifier({
      async verify() {
        throw new joseErrors.JWKSTimeout();
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer whatever" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("30");
      expect(response.json()).toMatchObject({
        error: "authentication_unavailable",
      });
      expect(response.json().message).not.toMatch(/invalid|expired/i);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the JWKS endpoint is unreachable end to end", async () => {
    const verifier = new JwksTokenVerifier({
      jwksUrl: new URL("http://127.0.0.1:65533/.well-known/jwks.json"),
      issuer: "https://project.example.test/auth/v1",
      audience: "authenticated",
    });
    const app = await appWithVerifier(verifier);
    try {
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("some-user")
        .setIssuer("https://project.example.test/auth/v1")
        .setAudience("authenticated")
        .sign(new TextEncoder().encode("does-not-matter-32-characters-long!"));

      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("30");
      expect(response.json()).toMatchObject({
        error: "authentication_unavailable",
      });
    } finally {
      await app.close();
    }
  });
});

describe("probeJwksEndpoint (G9)", () => {
  const jwksUrl = new URL("https://project.example.test/.well-known/jwks.json");

  it("logs key count and algorithms at info, never the keys themselves", async () => {
    const logger = recordingLogger();
    await probeJwksEndpoint(jwksUrl, logger, async () =>
      Response.json({
        keys: [
          { kty: "RSA", alg: "RS256", n: "should-never-be-logged", e: "AQAB" },
          { kty: "EC", crv: "P-256", x: "also-secret", y: "also-secret" },
        ],
      }),
    );

    expect(logger.warnCalls).toHaveLength(0);
    expect(logger.infoCalls).toHaveLength(1);
    const [payload, message] = logger.infoCalls[0]!;
    expect(message).toContain("Fetched the CollectFolio JWKS endpoint");
    expect(payload).toMatchObject({
      keyCount: 2,
      algorithms: expect.arrayContaining(["RS256", "EC(P-256)"]),
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("should-never-be-logged");
    expect(serialized).not.toContain("also-secret");
  });

  it("warns naming the asymmetric-signing precondition for an empty keyset", async () => {
    const logger = recordingLogger();
    await probeJwksEndpoint(jwksUrl, logger, async () =>
      Response.json({ keys: [] }),
    );

    expect(logger.infoCalls).toHaveLength(0);
    expect(logger.warnCalls).toHaveLength(1);
    const [, message] = logger.warnCalls[0]!;
    expect(message).toContain(JWKS_ASYMMETRIC_SIGNING_PRECONDITION);
  });

  it("warns naming the asymmetric-signing precondition when unreachable", async () => {
    const logger = recordingLogger();
    await probeJwksEndpoint(jwksUrl, logger, async () => {
      throw new TypeError("fetch failed");
    });

    expect(logger.infoCalls).toHaveLength(0);
    expect(logger.warnCalls).toHaveLength(1);
    const [payload, message] = logger.warnCalls[0]!;
    expect(message).toContain(JWKS_ASYMMETRIC_SIGNING_PRECONDITION);
    expect(payload).toMatchObject({ jwksUrl: jwksUrl.toString() });
  });

  it("warns on a non-OK HTTP status without throwing", async () => {
    const logger = recordingLogger();
    await probeJwksEndpoint(
      jwksUrl,
      logger,
      async () => new Response("not found", { status: 404 }),
    );

    expect(logger.warnCalls).toHaveLength(1);
    const [payload, message] = logger.warnCalls[0]!;
    expect(payload).toMatchObject({ status: 404 });
    expect(message).toContain(JWKS_ASYMMETRIC_SIGNING_PRECONDITION);
  });
});
