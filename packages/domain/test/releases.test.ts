import { describe, expect, it } from "vitest";
import {
  ConnectorManifestSchema,
  ProductionReleaseSchema,
  REQUIRED_RELEASE_EVIDENCE,
  REQUIRED_RELEASE_EVIDENCE_STATUS,
  ReleaseGateError,
  approveProductionRelease,
  deployProductionRelease,
  submitProductionRelease,
  type ConnectorManifest,
  type ProductionRelease,
} from "../src/index.js";

const now = "2026-08-20T12:00:00.000Z";

function connector(index: number): ConnectorManifest {
  return ConnectorManifestSchema.parse({
    id: `approved-${index}`,
    platform: `Local Market ${index}`,
    kind: index === 1 ? "android" : index === 2 ? "api" : "import",
    version: "1.0.0",
    definitionVersion: 1,
    enabled: true,
    killSwitchReason: null,
    policyStatus: "approved",
    productionMethod: "Documented and approved production method",
    approvalEvidenceUrl: `https://evidence.example.test/connectors/${index}`,
    policyReviewedAt: now,
    owner: "connectors@localclear.test",
    capabilities: {
      publish: true,
      edit: true,
      delist: true,
      mark_sold: true,
      message_read: false,
      message_send: false,
      import: index === 3,
    },
    supportedAppVersions: ["1.0.0"],
    requiredFields: ["title", "description", "price"],
    categoryMappings: { default: "general" },
    rateLimitPerMinute: 3,
    dailyListingCap: 50,
    canaryTestId: `canary-${index}`,
    changeLog: [
      {
        version: "1.0.0",
        changedAt: now,
        changedBy: "connector-owner",
        summary: "Reviewed release definition",
      },
    ],
  });
}

function release(): ProductionRelease {
  return ProductionReleaseSchema.parse({
    id: "release-1",
    version: "v1.0.0",
    target: "v1_public",
    summary: "Governed public release",
    connectorIds: ["approved-1", "approved-2", "approved-3"],
    evidence: REQUIRED_RELEASE_EVIDENCE.map((kind, index) => ({
      kind,
      status: REQUIRED_RELEASE_EVIDENCE_STATUS[kind],
      evidenceUrl: `https://evidence.example.test/release/${kind}`,
      contentSha256: index.toString(16).padStart(64, "0"),
      verifiedAt: now,
    })),
    status: "draft",
    createdBy: "release-author",
    approvalActorIds: [],
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
    deployedAt: null,
  });
}

describe("production release governance", () => {
  it("blocks submission when independent evidence is missing", () => {
    const draft = release();
    const incomplete = ProductionReleaseSchema.parse({
      ...draft,
      evidence: draft.evidence.filter(
        (entry) => entry.kind !== "mobile_penetration_test",
      ),
    });
    expect(() =>
      submitProductionRelease(
        incomplete,
        [connector(1), connector(2), connector(3)],
        now,
      ),
    ).toThrowError(ReleaseGateError);
  });

  it("requires passing evidence and policy approvals to use the right status", () => {
    const draft = release();
    const wrongStatus = ProductionReleaseSchema.parse({
      ...draft,
      evidence: draft.evidence.map((entry) =>
        entry.kind === "mobile_penetration_test"
          ? { ...entry, status: "approved" as const }
          : entry,
      ),
    });
    expect(() =>
      submitProductionRelease(
        wrongStatus,
        [connector(1), connector(2), connector(3)],
        now,
      ),
    ).toThrow("incomplete");
  });

  it("requires two distinct non-author approvals before deployment", () => {
    const submitted = submitProductionRelease(
      release(),
      [connector(1), connector(2), connector(3)],
      now,
    );
    expect(() =>
      approveProductionRelease(submitted, "release-author", now),
    ).toThrow("self-approve");
    const first = approveProductionRelease(submitted, "admin-one", now);
    expect(first.status).toBe("pending_approval");
    expect(() => approveProductionRelease(first, "admin-one", now)).toThrow(
      "approve only once",
    );
    const approved = approveProductionRelease(first, "admin-two", now);
    expect(approved).toMatchObject({
      status: "approved",
      approvalActorIds: ["admin-one", "admin-two"],
    });
    expect(() =>
      deployProductionRelease(approved, "unrelated-admin", now),
    ).toThrow("approving administrator");
    expect(deployProductionRelease(approved, "admin-two", now).status).toBe(
      "deployed",
    );
  });
});
