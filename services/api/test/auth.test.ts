import Fastify from "fastify";
import { errors as joseErrors, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  createAuthenticationHook,
  JwksTokenVerifier,
  type TokenVerifier,
} from "../src/auth.js";

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
