import {
  SpanStatusCode,
  metrics,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type {
  ConnectorManifest,
  PublishingJob,
  PublishingTransition,
} from "@localclear/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

const instrumentationName = "localclear.api";
const meter = metrics.getMeter(instrumentationName, "0.1.0");
const tracer = trace.getTracer(instrumentationName, "0.1.0");
const httpRequestCount = meter.createCounter("localclear.http.requests", {
  description: "Count of API requests",
});
const httpRequestDuration = meter.createHistogram(
  "localclear.http.request.duration",
  { description: "API request duration", unit: "ms" },
);
const publishingTransitions = meter.createCounter(
  "localclear.publishing.transitions",
  { description: "Publishing state transitions" },
);
const publishingStateDuration = meter.createHistogram(
  "localclear.publishing.state.duration",
  { description: "Time spent in the previous publishing state", unit: "ms" },
);
const queuedPublishingJobs = meter.createCounter(
  "localclear.publishing.jobs.queued",
  { description: "Publishing jobs admitted by connector policy" },
);
const duplicateBlocks = meter.createCounter(
  "localclear.publishing.duplicate_blocks",
  { description: "Likely duplicate publishing attempts blocked" },
);
const publishConfirmations = meter.createCounter(
  "localclear.publishing.confirmations",
  { description: "Verified listing publication confirmations" },
);
const interventions = meter.createCounter(
  "localclear.publishing.interventions",
  { description: "Publishing jobs paused for a bounded intervention type" },
);

// Card-lookup domain metrics (G12c). Every `record*` function below is
// safe to call unconditionally, telemetry initialized or not:
// @opentelemetry/api's default meter (what `getMeter` returns before any
// MeterProvider is registered) is a documented no-op, so a histogram
// `.record()`/counter `.add()` here never throws and never accumulates
// data until `initializeTelemetry` actually starts one.
const cardLookupRecognitionDuration = meter.createHistogram(
  "card_lookup.recognition.duration",
  { description: "Card recognition provider call duration", unit: "ms" },
);
const cardLookupCatalogDuration = meter.createHistogram(
  "card_lookup.catalog.duration",
  { description: "Card catalog search duration", unit: "ms" },
);
const cardLookupsByOutcome = meter.createCounter("card_lookup.lookups", {
  description: "Completed card lookups by outcome",
});
const cardLookupProviderFailures = meter.createCounter(
  "card_lookup.recognition.failures",
  { description: "Card recognition provider failures by G16 classification" },
);
const cardLookupRateLimited = meter.createCounter("card_lookup.rate_limited", {
  description: "Card lookups rejected for exceeding the per-user hourly quota",
});
const cardLookupBusy = meter.createCounter("card_lookup.busy", {
  description:
    "Card lookups rejected because the vision concurrency gate was full",
});
const cardLookupMediaRejected = meter.createCounter(
  "card_lookup.media_rejected",
  {
    description: "Card lookup images rejected by media verification, by reason",
  },
);

export function recordCardLookupRecognitionDuration(
  durationMs: number,
  provider: string,
  outcome: string,
): void {
  cardLookupRecognitionDuration.record(durationMs, { provider, outcome });
}

export function recordCardLookupCatalogDuration(
  durationMs: number,
  provider: string,
  outcome: string,
): void {
  cardLookupCatalogDuration.record(durationMs, { provider, outcome });
}

export function recordCardLookupOutcome(
  outcome: string,
  provider: string,
): void {
  cardLookupsByOutcome.add(1, { outcome, provider });
}

export function recordCardLookupProviderFailure(
  provider: string,
  code: string,
): void {
  cardLookupProviderFailures.add(1, { provider, code });
}

export function recordCardLookupRateLimited(): void {
  cardLookupRateLimited.add(1);
}

export function recordCardLookupBusy(): void {
  cardLookupBusy.add(1);
}

export function recordCardLookupMediaRejected(reason: string): void {
  cardLookupMediaRejected.add(1, { reason });
}

export const REDACTED_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "body",
  "request.body",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "cookie",
  "session",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.cookie",
  "*.session",
  "err.config.headers.authorization",
  "err.config.headers.Authorization",
] as const;

export interface TelemetryOptions {
  endpoint: string | undefined;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  exportIntervalMs: number;
}

export function initializeTelemetry(options: TelemetryOptions): {
  enabled: boolean;
  shutdown(): Promise<void>;
} {
  if (!options.endpoint) {
    return { enabled: false, async shutdown() {} };
  }
  const traceExporter = new OTLPTraceExporter({
    url: signalUrl(options.endpoint, "v1/traces"),
  });
  const metricExporter = new OTLPMetricExporter({
    url: signalUrl(options.endpoint, "v1/metrics"),
  });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
      "deployment.environment.name": options.environment,
    }),
    traceExporter,
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: options.exportIntervalMs,
      }),
    ],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}

export function registerHttpObservability(app: FastifyInstance): void {
  const active = new WeakMap<
    FastifyRequest,
    { startedAt: bigint; span: Span }
  >();
  app.addHook("onRequest", async (request) => {
    const span = tracer.startSpan("HTTP request", {
      attributes: { "http.request.method": request.method },
    });
    active.set(request, { startedAt: process.hrtime.bigint(), span });
  });
  app.addHook("onError", async (request, _reply, error) => {
    const current = active.get(request);
    if (!current) return;
    current.span.setAttribute("error.type", error.name || "Error");
    current.span.setStatus({ code: SpanStatusCode.ERROR });
  });
  app.addHook("onResponse", async (request, reply) => {
    const current = active.get(request);
    if (!current) return;
    const route = request.routeOptions.url || "unmatched";
    const durationMs =
      Number(process.hrtime.bigint() - current.startedAt) / 1_000_000;
    const attributes: Attributes = {
      "http.request.method": request.method,
      "http.route": route,
      "http.response.status_code": reply.statusCode,
    };
    httpRequestCount.add(1, attributes);
    httpRequestDuration.record(durationMs, attributes);
    current.span.updateName(`${request.method} ${route}`);
    current.span.setAttributes(attributes);
    if (reply.statusCode >= 500) {
      current.span.setStatus({ code: SpanStatusCode.ERROR });
    } else {
      current.span.setStatus({ code: SpanStatusCode.OK });
    }
    current.span.end();
    active.delete(request);
  });
}

export function recordPublishingTransition(input: {
  before: PublishingJob;
  after: PublishingJob;
  transition: PublishingTransition;
  appVersion: string;
}): void {
  const attributes: Attributes = {
    "localclear.platform": input.after.platform,
    "localclear.connector.version": input.after.connectorVersion,
    "localclear.marketplace_app.version": input.appVersion,
    "localclear.publishing.action": input.after.commandAction,
    "localclear.publishing.from_state": input.transition.from,
    "localclear.publishing.to_state": input.transition.to,
    "localclear.publishing.failure_reason":
      input.transition.reasonCode ?? "none",
    "localclear.publishing.retry_count": input.after.retryCount,
  };
  publishingTransitions.add(1, attributes);
  publishingStateDuration.record(
    Math.max(
      0,
      Date.parse(input.transition.occurredAt) -
        Date.parse(input.before.updatedAt),
    ),
    attributes,
  );
  if (
    input.transition.to.startsWith("NEEDS_") ||
    isInterventionState(input.transition.to)
  ) {
    interventions.add(1, {
      "localclear.platform": input.after.platform,
      "localclear.connector.version": input.after.connectorVersion,
      "localclear.intervention.type": input.transition.to,
    });
  }
}

export function recordPublishingJobQueued(
  manifest: ConnectorManifest,
  action: PublishingJob["commandAction"],
): void {
  queuedPublishingJobs.add(1, {
    "localclear.platform": manifest.platform,
    "localclear.connector.version": manifest.version,
    "localclear.connector.policy_status": manifest.policyStatus,
    "localclear.connector.kind": manifest.kind,
    "localclear.publishing.action": action,
  });
}

export function recordDuplicateBlock(matchCount: number): void {
  duplicateBlocks.add(1, {
    "localclear.duplicate.match_count": Math.min(matchCount, 100),
  });
}

export function recordPublishConfirmation(input: {
  platform: string;
  connectorVersion: string;
  method:
    | "official_api_response"
    | "seller_hub_receipt"
    | "explicit_import_confirmation";
}): void {
  publishConfirmations.add(1, {
    "localclear.platform": input.platform,
    "localclear.connector.version": input.connectorVersion,
    "localclear.confirmation.method": input.method,
  });
}

function signalUrl(endpoint: string, signalPath: string): string {
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  return new URL(signalPath, base).toString();
}

function isInterventionState(state: string): boolean {
  return [
    "APP_VERSION_UNSUPPORTED",
    "PLATFORM_UI_CHANGED",
    "ITEM_BLOCKED",
    "LISTING_LIMIT_REACHED",
    "NETWORK_UNAVAILABLE",
    "DEVICE_OFFLINE",
  ].includes(state);
}
