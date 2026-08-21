import { describe, expect, it } from "vitest";
import {
  ConnectorManifestSchema,
  RESTRICTED_PLATFORM_POLICIES,
  evaluateConnectorGate,
  type ConnectorManifest,
} from "../src/index.js";

function manifest(
  overrides: Partial<ConnectorManifest> = {},
): ConnectorManifest {
  return ConnectorManifestSchema.parse({
    id: "connector-test-market",
    platform: "Test Market",
    kind: "android",
    version: "1.0.0",
    definitionVersion: 1,
    enabled: true,
    killSwitchReason: null,
    policyStatus: "approved",
    productionMethod:
      "Written sandbox approval for deterministic device workflow",
    approvalEvidenceUrl: "https://example.test/approval/1",
    policyReviewedAt: "2026-08-20T12:00:00.000Z",
    owner: "connectors@localclear.test",
    capabilities: {
      publish: true,
      edit: true,
      delist: true,
      mark_sold: true,
      message_read: false,
      message_send: false,
      import: false,
    },
    supportedAppVersions: ["10.4.0"],
    requiredFields: ["title", "description", "price"],
    categoryMappings: { furniture: "home/furniture" },
    rateLimitPerMinute: 2,
    dailyListingCap: 25,
    canaryTestId: "canary-test-market",
    changeLog: [
      {
        version: "1.0.0",
        changedAt: "2026-08-20T12:00:00.000Z",
        changedBy: "connector-owner",
        summary: "Initial reviewed definition",
      },
    ],
    ...overrides,
  });
}

describe("connector policy gate", () => {
  it("allows a fully documented production connector", () => {
    expect(
      evaluateConnectorGate({
        manifest: manifest(),
        capability: "publish",
        environment: "production",
        appVersion: "10.4.0",
      }),
    ).toEqual({ allowed: true, blockers: [] });
  });

  it("blocks the remote kill switch immediately", () => {
    const result = evaluateConnectorGate({
      manifest: manifest({ enabled: false, killSwitchReason: "Failure spike" }),
      capability: "publish",
      environment: "production",
      appVersion: "10.4.0",
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers).toContain("Failure spike");
  });

  it("blocks unsupported app versions rather than running unpredictably", () => {
    const result = evaluateConnectorGate({
      manifest: manifest(),
      capability: "publish",
      environment: "production",
      appVersion: "10.5.0",
    });
    expect(result.blockers).toContain("App version 10.5.0 is not supported");
  });

  it("permits review-only connectors only for internal testing", () => {
    const review = manifest({ policyStatus: "review" });
    expect(
      evaluateConnectorGate({
        manifest: review,
        capability: "publish",
        environment: "internal",
        appVersion: "10.4.0",
      }).allowed,
    ).toBe(true);
    expect(
      evaluateConnectorGate({
        manifest: review,
        capability: "publish",
        environment: "beta",
        appVersion: "10.4.0",
      }).allowed,
    ).toBe(false);
  });

  it("keeps prohibited public automation disabled by default", () => {
    expect(RESTRICTED_PLATFORM_POLICIES.offerup.policyStatus).toBe("disabled");
    expect(RESTRICTED_PLATFORM_POLICIES.craigslist.policyStatus).toBe(
      "disabled",
    );
    expect(RESTRICTED_PLATFORM_POLICIES.ebay.policyStatus).toBe("disabled");
  });
});
