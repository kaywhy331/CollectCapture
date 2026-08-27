import { isIPv4, isIPv6 } from "node:net";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { ZodError } from "zod";
import {
  JwksTokenVerifier,
  probeJwksEndpoint,
  type TokenVerifier,
} from "./auth.js";
import { cardLookupHttpPlugin } from "./card-lookup-http.js";
import type { TrustedProxyMode } from "./card-lookup-config.js";
import { createRefundableRateLimitStore } from "./card-lookup-rate-limit-store.js";
import {
  CATALOG_TOTAL_TIMEOUT_MS,
  GroqCardRecognitionProvider,
  OllamaCardRecognitionProvider,
  OpenAICardRecognitionProvider,
  RECOGNITION_TIMEOUT_MS,
  StatelessCardLookupService,
  TcgcsvCardCatalogProvider,
  type CardLookupHandler,
} from "./card-lookups.js";
import { ApplicationError } from "./errors.js";
import { registerHttpObservability } from "./observability.js";

interface CardLookupRuntimeBaseOptions {
  collectFolioSupabaseUrl: string;
  collectFolioSupabaseJwksUrl?: string;
  collectFolioCatalogUrl: string;
  /**
   * Fires a non-fatal JWKS reachability probe at startup (G9), logging key
   * count/algorithms or a warning naming the asymmetric-signing-keys
   * precondition. Off by default so this function's other callers (the
   * main LocalClear app, tests) don't gain a side-effecting network call;
   * the standalone entrypoint opts in.
   */
  probeJwksAtStartup?: boolean;
  /**
   * Shortest-side pixel minimum a card image must meet (G22). `0` (the
   * default) disables the gate entirely -- dimensions are not even
   * parsed -- so default-config behavior, including existing 1x1 test
   * fixtures, is unchanged.
   */
  minCardImageDimension?: number;
}

export type CardLookupRuntimeOptions = CardLookupRuntimeBaseOptions &
  (
    | {
        recognitionProvider?: "openai";
        openAIApiKey: string;
        openAIModel: string;
      }
    | {
        recognitionProvider: "ollama";
        ollamaBaseUrl: string;
        ollamaApiKey?: string;
        ollamaModel: string;
        ollamaTimeoutMs: number;
      }
    | {
        recognitionProvider: "groq";
        groqApiKey: string;
        groqModel: string;
        groqTimeoutMs: number;
        groqReasoningEffort?: string;
        groqResponseFormat?: "json_object" | "json_schema";
        groqMaxCompletionTokens?: number;
      }
  );

export interface CardLookupRuntime {
  tokenVerifier: TokenVerifier;
  service: CardLookupHandler;
}

/** Cloudflare's documented tunnel/edge request deadline, roughly. */
const CLOUDFLARE_EDGE_DEADLINE_MS = 100_000;
/** CollectFolio's documented browser-side abort deadline. */
const BROWSER_DEADLINE_MS = 30_000;

/**
 * Warns at startup when the selected provider's recognition timeout plus
 * the fixed catalog budget would exceed Cloudflare's edge deadline -- a
 * lookup that legitimately runs that long is going to fail at the edge (or
 * in the browser, whose own deadline is shorter still) no matter what the
 * server does.
 */
function warnIfDeadlineBudgetExceedsEdge(
  options: CardLookupRuntimeOptions,
): void {
  const [providerName, providerTimeoutMs] =
    options.recognitionProvider === "ollama"
      ? (["Ollama", options.ollamaTimeoutMs] as const)
      : options.recognitionProvider === "groq"
        ? (["Groq", options.groqTimeoutMs] as const)
        : (["OpenAI", RECOGNITION_TIMEOUT_MS] as const);
  const totalBudgetMs = providerTimeoutMs + CATALOG_TOTAL_TIMEOUT_MS;
  if (totalBudgetMs <= CLOUDFLARE_EDGE_DEADLINE_MS) return;
  console.warn(
    `[card-lookups] ${providerName} recognition timeout (${providerTimeoutMs} ms) plus the ${CATALOG_TOTAL_TIMEOUT_MS} ms catalog budget is ${totalBudgetMs} ms, which exceeds Cloudflare's roughly ${CLOUDFLARE_EDGE_DEADLINE_MS} ms edge deadline. The documented CollectFolio browser deadline is only ${BROWSER_DEADLINE_MS} ms, shorter still. A lookup that actually runs this long will already fail at the edge or in the browser before the server finishes -- lower the provider timeout, or accept that slow lookups will time out upstream.`,
  );
}

export function createCardLookupRuntime(
  options: CardLookupRuntimeOptions,
): CardLookupRuntime {
  warnIfDeadlineBudgetExceedsEdge(options);
  const issuer = new URL("/auth/v1", options.collectFolioSupabaseUrl)
    .toString()
    .replace(/\/$/, "");
  const jwksUrl = new URL(
    options.collectFolioSupabaseJwksUrl ?? `${issuer}/.well-known/jwks.json`,
  );
  if (options.probeJwksAtStartup) {
    // Fire-and-forget: a startup probe is informational (G9), never a
    // readiness gate -- `jwtVerify` itself fetches fresh keys (and surfaces
    // a proper 503) on first real use regardless of what this finds.
    void probeJwksEndpoint(jwksUrl, console);
  }
  return {
    tokenVerifier: new JwksTokenVerifier({
      jwksUrl,
      issuer,
      audience: "authenticated",
    }),
    service: new StatelessCardLookupService(
      options.recognitionProvider === "ollama"
        ? new OllamaCardRecognitionProvider({
            baseUrl: options.ollamaBaseUrl,
            ...(options.ollamaApiKey ? { apiKey: options.ollamaApiKey } : {}),
            model: options.ollamaModel,
            timeoutMs: options.ollamaTimeoutMs,
          })
        : options.recognitionProvider === "groq"
          ? new GroqCardRecognitionProvider({
              apiKey: options.groqApiKey,
              model: options.groqModel,
              timeoutMs: options.groqTimeoutMs,
              ...(options.groqReasoningEffort === undefined
                ? {}
                : { reasoningEffort: options.groqReasoningEffort }),
              ...(options.groqResponseFormat === undefined
                ? {}
                : { responseFormat: options.groqResponseFormat }),
              ...(options.groqMaxCompletionTokens === undefined
                ? {}
                : { maxCompletionTokens: options.groqMaxCompletionTokens }),
            })
          : new OpenAICardRecognitionProvider({
              apiKey: options.openAIApiKey,
              model: options.openAIModel,
            }),
      new TcgcsvCardCatalogProvider({
        baseUrl: options.collectFolioCatalogUrl,
      }),
      { minCardImageDimension: options.minCardImageDimension ?? 0 },
    ),
  };
}

export interface BuildCardLookupAppOptions extends CardLookupRuntime {
  allowedOrigin: string;
  logger?: FastifyServerOptions["logger"];
  /**
   * `"cloudflare-tunnel"` keys the pre-auth global rate limiter on the
   * `cf-connecting-ip` header instead of the socket address, but only when
   * the socket address is the private/loopback range the cloudflared
   * sidecar connects from — a public source cannot forge the header to hop
   * buckets. Defaults to `"none"`, which is byte-for-byte today's behavior.
   */
  trustedProxyMode?: TrustedProxyMode;
  /** Caps concurrent vision-recognition calls. Defaults to 2. */
  maxConcurrentVisionLookups?: number;
}

/**
 * RFC1918 (10/8, 172.16/12, 192.168/16), IPv4 loopback (127/8), IPv6
 * loopback (::1), and unique local IPv6 (fc00::/7) — the address ranges the
 * cloudflared sidecar connects from over the private Compose network. This
 * never changes `request.ip`/`trustProxy`; it only decides whether the
 * rate-limit key generator may trust `cf-connecting-ip`.
 */
function isPrivateOrLoopbackAddress(address: string): boolean {
  const normalized = address.startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;
  if (isIPv4(normalized)) {
    const octets = normalized.split(".").map(Number);
    const [firstOctet, secondOctet] = octets;
    return (
      firstOctet === 127 ||
      firstOctet === 10 ||
      (firstOctet === 172 && secondOctet! >= 16 && secondOctet! <= 31) ||
      (firstOctet === 192 && secondOctet === 168)
    );
  }
  if (isIPv6(address)) {
    const lower = address.toLowerCase();
    return lower === "::1" || /^f[cd][0-9a-f]{2}:/.test(lower);
  }
  return false;
}

function cloudflareTunnelRateLimitKeyGenerator(
  request: FastifyRequest,
): string {
  const socketAddress = request.socket?.remoteAddress ?? "";
  const forwardedHeader = request.headers["cf-connecting-ip"];
  const forwardedFor =
    typeof forwardedHeader === "string" ? forwardedHeader.trim() : "";
  // The "ip:" prefix keeps these buckets in a namespace disjoint from the
  // per-user quota's "collectfolio-card-lookups:" keys by construction --
  // both limiters share one refundable backing map, and the header value
  // is caller-supplied for a direct private-network connection, so without
  // the prefix such a caller could address another limiter's bucket.
  if (forwardedFor && isPrivateOrLoopbackAddress(socketAddress)) {
    return `ip:${forwardedFor}`;
  }
  return `ip:${socketAddress}`;
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
    maxAge: 86_400,
    origin(origin, callback) {
      if (!origin || origin === options.allowedOrigin) {
        callback(null, true);
      } else {
        callback(new Error("Origin is not allowed"), false);
      }
    },
  });
  // A refundable store (G7) so the per-user 30/hour quota that
  // `cardLookupHttpPlugin` charges through `app.createRateLimit` below can
  // give back a unit for a lookup that failed server-side. Built fresh per
  // app so its state never leaks between independently built apps; each
  // limiter (the global one below, the per-user quota) gets its own
  // isolated map, matching the library's own LocalStore semantics.
  const cardLookupQuotaStore = createRefundableRateLimitStore();
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    store: cardLookupQuotaStore.Store,
    ...(options.trustedProxyMode === "cloudflare-tunnel"
      ? { keyGenerator: cloudflareTunnelRateLimitKeyGenerator }
      : {}),
    // Must return an `ApplicationError` (not a plain object) so the shared
    // error handler below recognizes it and replies `429`/`rate_limited`
    // instead of falling through to its generic `500 internal_error`
    // branch, which has no `statusCode` to key off of (G26). The library
    // itself already stamped the standard `x-ratelimit-*`/`retry-after`
    // headers onto `reply` before calling this builder.
    errorResponseBuilder: (_request, context) =>
      new ApplicationError(
        context.statusCode,
        "rate_limited",
        "Too many requests. Please try again shortly.",
      ),
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
    refundQuota: cardLookupQuotaStore.refund,
    ...(options.maxConcurrentVisionLookups === undefined
      ? {}
      : { maxConcurrentVisionLookups: options.maxConcurrentVisionLookups }),
  });
  app.setNotFoundHandler(async (_request, reply) => {
    await reply
      .code(404)
      .send({ error: "not_found", message: "Route was not found" });
  });

  return app;
}
