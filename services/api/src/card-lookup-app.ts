import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { ZodError } from "zod";
import { JwksTokenVerifier, type TokenVerifier } from "./auth.js";
import { cardLookupHttpPlugin } from "./card-lookup-http.js";
import {
  OpenAICardRecognitionProvider,
  StatelessCardLookupService,
  TcgcsvCardCatalogProvider,
  type CardLookupHandler,
} from "./card-lookups.js";
import { ApplicationError } from "./errors.js";
import { registerHttpObservability } from "./observability.js";

export interface CardLookupRuntimeOptions {
  openAIApiKey: string;
  openAIModel: string;
  collectFolioSupabaseUrl: string;
  collectFolioSupabaseJwksUrl?: string;
  collectFolioCatalogUrl: string;
}

export interface CardLookupRuntime {
  tokenVerifier: TokenVerifier;
  service: CardLookupHandler;
}

export function createCardLookupRuntime(
  options: CardLookupRuntimeOptions,
): CardLookupRuntime {
  const issuer = new URL("/auth/v1", options.collectFolioSupabaseUrl)
    .toString()
    .replace(/\/$/, "");
  return {
    tokenVerifier: new JwksTokenVerifier({
      jwksUrl: new URL(
        options.collectFolioSupabaseJwksUrl ??
          `${issuer}/.well-known/jwks.json`,
      ),
      issuer,
      audience: "authenticated",
    }),
    service: new StatelessCardLookupService(
      new OpenAICardRecognitionProvider({
        apiKey: options.openAIApiKey,
        model: options.openAIModel,
      }),
      new TcgcsvCardCatalogProvider({
        baseUrl: options.collectFolioCatalogUrl,
      }),
    ),
  };
}

export interface BuildCardLookupAppOptions extends CardLookupRuntime {
  allowedOrigin: string;
  logger?: FastifyServerOptions["logger"];
}

export async function buildCardLookupApp(
  options: BuildCardLookupAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: "x-request-id",
    trustProxy: false,
  });

  registerHttpObservability(app);

  await app.register(helmet, { global: true });
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || origin === options.allowedOrigin) {
        callback(null, true);
      } else {
        callback(new Error("Origin is not allowed"), false);
      }
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      error: "rate_limited",
      message: "Too many requests. Please try again shortly.",
    }),
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      await reply.code(400).send({
        error: "invalid_request",
        message: "The request contains invalid fields",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof ApplicationError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    ) {
      await reply.code(error.statusCode).send({
        error: "request_rejected",
        message:
          "message" in error && typeof error.message === "string"
            ? error.message
            : "Request rejected",
      });
      return;
    }
    request.log.error({ err: error }, "Unhandled request error");
    await reply.code(500).send({
      error: "internal_error",
      message: "The request could not be completed",
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "collectcapture-card-lookups",
  }));
  await app.register(cardLookupHttpPlugin, {
    tokenVerifier: options.tokenVerifier,
    service: options.service,
  });
  app.setNotFoundHandler(async (_request, reply) => {
    await reply
      .code(404)
      .send({ error: "not_found", message: "Route was not found" });
  });

  return app;
}
