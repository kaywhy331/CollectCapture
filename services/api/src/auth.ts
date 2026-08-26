import { createHash } from "node:crypto";
import type { SellerDevice } from "@localclear/domain";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Repository } from "./repository.js";

export interface AuthPrincipal {
  userId: string;
  email: string | null;
  roles: string[];
  authenticationAssuranceLevel?: "aal1" | "aal2" | null;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: AuthPrincipal;
    devicePrincipal: SellerDevice;
  }
}

export function createDeviceAuthenticationHook(repository: Repository) {
  return async function authenticateDevice(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Device ")) {
      await reply.code(401).send({
        error: "device_unauthorized",
        message: "A Seller Hub device credential is required",
      });
      return;
    }
    const token = authorization.slice("Device ".length);
    const separator = token.indexOf(".");
    if (separator < 1) {
      await reply.code(401).send({
        error: "device_unauthorized",
        message: "The Seller Hub credential is invalid or revoked",
      });
      return;
    }
    const deviceId = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      await reply.code(401).send({
        error: "device_unauthorized",
        message: "The Seller Hub credential is invalid or revoked",
      });
      return;
    }
    const tokenHash = createHash("sha256").update(secret).digest("hex");
    const device = await repository.authenticateSellerDeviceToken(
      deviceId,
      tokenHash,
      new Date().toISOString(),
    );
    if (!device) {
      await reply.code(401).send({
        error: "device_unauthorized",
        message: "The Seller Hub credential is invalid or revoked",
      });
      return;
    }
    request.devicePrincipal = device;
  };
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthPrincipal>;
}

function principalFromPayload(payload: JWTPayload): AuthPrincipal {
  if (!payload.sub) {
    throw new Error("Token subject is missing");
  }
  const email = typeof payload.email === "string" ? payload.email : null;
  const appMetadata = payload.app_metadata;
  const roles =
    typeof appMetadata === "object" &&
    appMetadata !== null &&
    "roles" in appMetadata &&
    Array.isArray(appMetadata.roles)
      ? appMetadata.roles.filter(
          (role): role is string => typeof role === "string",
        )
      : [];
  const authenticationAssuranceLevel =
    payload.aal === "aal1" || payload.aal === "aal2" ? payload.aal : null;
  return { userId: payload.sub, email, roles, authenticationAssuranceLevel };
}

export class SharedSecretTokenVerifier implements TokenVerifier {
  readonly #secret: Uint8Array;
  readonly #issuer: string | undefined;
  readonly #audience: string | undefined;

  constructor(input: { secret: string; issuer?: string; audience?: string }) {
    this.#secret = new TextEncoder().encode(input.secret);
    this.#issuer = input.issuer;
    this.#audience = input.audience;
  }

  async verify(token: string): Promise<AuthPrincipal> {
    const options = {
      ...(this.#issuer ? { issuer: this.#issuer } : {}),
      ...(this.#audience ? { audience: this.#audience } : {}),
    };
    const { payload } = await jwtVerify(token, this.#secret, options);
    return principalFromPayload(payload);
  }
}

export class JwksTokenVerifier implements TokenVerifier {
  readonly #keySet: ReturnType<typeof createRemoteJWKSet>;
  readonly #issuer: string;
  readonly #audience: string | undefined;

  constructor(input: { jwksUrl: URL; issuer: string; audience?: string }) {
    this.#keySet = createRemoteJWKSet(input.jwksUrl);
    this.#issuer = input.issuer;
    this.#audience = input.audience;
  }

  async verify(token: string): Promise<AuthPrincipal> {
    const { payload } = await jwtVerify(token, this.#keySet, {
      issuer: this.#issuer,
      ...(this.#audience ? { audience: this.#audience } : {}),
    });
    return principalFromPayload(payload);
  }
}

export class StaticTokenVerifier implements TokenVerifier {
  constructor(private readonly tokens: ReadonlyMap<string, AuthPrincipal>) {}

  async verify(token: string): Promise<AuthPrincipal> {
    const principal = this.tokens.get(token);
    if (!principal) throw new Error("Unknown test token");
    return principal;
  }
}

/**
 * Distinguishes a JWKS key-retrieval infrastructure failure (the discovery
 * endpoint is unreachable, timed out, or returned a bad response) from an
 * actual token problem (bad signature, expired, wrong issuer/audience, no
 * matching key). jose throws the base {@link joseErrors.JOSEError} directly
 * only for the two JWKS-fetch failures below it does not have a dedicated
 * subclass for; every token-validation failure uses a specific subclass
 * instead, so checking the exact constructor keeps those told apart. A raw
 * `TypeError` (Node's fetch throws `TypeError: fetch failed` for DNS/connect
 * failures) never comes from token validation either.
 */
function isAuthenticationInfrastructureFailure(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout) return true;
  if (error instanceof TypeError) return true;
  return (
    error instanceof joseErrors.JOSEError &&
    error.constructor === joseErrors.JOSEError
  );
}

export function createAuthenticationHook(verifier: TokenVerifier) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      await reply.code(401).send({
        error: "unauthorized",
        message: "A bearer token is required",
      });
      return;
    }

    try {
      request.principal = await verifier.verify(
        authorization.slice("Bearer ".length),
      );
    } catch (error) {
      if (isAuthenticationInfrastructureFailure(error)) {
        await reply
          .code(503)
          .header("retry-after", "30")
          .send({
            error: "authentication_unavailable",
            message:
              "CollectCapture could not reach the sign-in service. Please try again shortly.",
          });
        return;
      }
      await reply.code(401).send({
        error: "unauthorized",
        message: "The bearer token is invalid or expired",
      });
    }
  };
}
