import { describe, expect, it } from "vitest";
import {
  recordCardLookupBusy,
  recordCardLookupCatalogDuration,
  recordCardLookupMediaRejected,
  recordCardLookupOutcome,
  recordCardLookupProviderFailure,
  recordCardLookupRateLimited,
  recordCardLookupRecognitionDuration,
} from "../src/observability.js";

// G12c: every card_lookup.* metric must be safe to call whether or not
// initializeTelemetry ever ran. @opentelemetry/api's default meter (no
// MeterProvider registered, exactly this test's situation) is documented
// as a no-op, so none of these should throw.
describe("card lookup metrics are no-op safe without telemetry (G12c)", () => {
  it("records recognition/catalog duration histograms without throwing", () => {
    expect(() =>
      recordCardLookupRecognitionDuration(123, "groq", "success"),
    ).not.toThrow();
    expect(() =>
      recordCardLookupCatalogDuration(456, "groq", "success"),
    ).not.toThrow();
  });

  it("records the outcome counter without throwing", () => {
    expect(() => recordCardLookupOutcome("success", "openai")).not.toThrow();
    expect(() =>
      recordCardLookupOutcome("card_recognition_timeout", "ollama"),
    ).not.toThrow();
  });

  it("records a provider failure by G16 classification without throwing", () => {
    expect(() =>
      recordCardLookupProviderFailure("groq", "card_recognition_unavailable"),
    ).not.toThrow();
  });

  it("records a per-user 429 without throwing", () => {
    expect(() => recordCardLookupRateLimited()).not.toThrow();
  });

  it("records a busy 503 without throwing", () => {
    expect(() => recordCardLookupBusy()).not.toThrow();
  });

  it("records a media rejection by reason without throwing", () => {
    expect(() =>
      recordCardLookupMediaRejected("media_type_mismatch"),
    ).not.toThrow();
  });
});
