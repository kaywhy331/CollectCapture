import type { ConnectorManifest } from "./connectors.js";
import type { ProductionRelease, ReleaseEvidenceKind } from "./schemas.js";
import { ProductionReleaseSchema } from "./schemas.js";

export const REQUIRED_RELEASE_EVIDENCE = [
  "threat_model",
  "security_architecture_review",
  "mobile_penetration_test",
  "api_penetration_test",
  "dependency_scan",
  "secret_scan",
  "sbom",
  "incident_response_plan",
  "data_retention_policy",
  "privacy_policy",
  "terms_of_use",
] as const satisfies readonly ReleaseEvidenceKind[];

export const REQUIRED_RELEASE_EVIDENCE_STATUS = Object.freeze({
  threat_model: "approved",
  security_architecture_review: "approved",
  mobile_penetration_test: "passed",
  api_penetration_test: "passed",
  dependency_scan: "passed",
  secret_scan: "passed",
  sbom: "passed",
  incident_response_plan: "approved",
  data_retention_policy: "approved",
  privacy_policy: "approved",
  terms_of_use: "approved",
} as const satisfies Record<ReleaseEvidenceKind, "passed" | "approved">);

export class ReleaseGateError extends Error {
  constructor(
    message: string,
    readonly blockers: readonly string[],
  ) {
    super(message);
    this.name = "ReleaseGateError";
  }
}

export function assertReleaseReady(
  release: ProductionRelease,
  connectors: readonly ConnectorManifest[],
): void {
  const blockers: string[] = [];
  const evidenceKinds = new Set(release.evidence.map((entry) => entry.kind));
  for (const kind of REQUIRED_RELEASE_EVIDENCE) {
    if (!evidenceKinds.has(kind)) blockers.push(`missing evidence: ${kind}`);
  }
  for (const entry of release.evidence) {
    const expected = REQUIRED_RELEASE_EVIDENCE_STATUS[entry.kind];
    if (entry.status !== expected) {
      blockers.push(
        `${entry.kind} must be recorded as ${expected}, not ${entry.status}`,
      );
    }
  }
  if (evidenceKinds.size !== release.evidence.length) {
    blockers.push("release evidence kinds must be unique");
  }

  const selected = release.connectorIds.map((id) =>
    connectors.find((connector) => connector.id === id),
  );
  if (selected.some((connector) => !connector)) {
    blockers.push("every release connector must exist");
  }
  const requiredCount = release.target === "public_beta" ? 2 : 3;
  if (selected.length < requiredCount) {
    blockers.push(
      `${release.target} requires at least ${requiredCount} connectors`,
    );
  }
  if (
    release.target === "v1_public" &&
    selected.some((connector) => connector?.platform.toLowerCase() === "ebay")
  ) {
    blockers.push("v1_public cannot depend on eBay");
  }
  for (const connector of selected) {
    if (!connector) continue;
    if (
      !connector.enabled ||
      connector.policyStatus !== "approved" ||
      !connector.productionMethod ||
      !connector.approvalEvidenceUrl ||
      connector.supportedAppVersions.length === 0 ||
      !connector.canaryTestId ||
      !connector.owner
    ) {
      blockers.push(`${connector.platform} is not production-ready`);
    }
  }
  if (blockers.length > 0) {
    throw new ReleaseGateError("Release evidence is incomplete", blockers);
  }
}

export function submitProductionRelease(
  release: ProductionRelease,
  connectors: readonly ConnectorManifest[],
  now: string,
): ProductionRelease {
  if (!release.status.match(/^(draft|rejected)$/)) {
    throw new ReleaseGateError(
      "Only draft or rejected releases can be submitted",
      [`current status: ${release.status}`],
    );
  }
  assertReleaseReady(release, connectors);
  return ProductionReleaseSchema.parse({
    ...release,
    status: "pending_approval",
    approvalActorIds: [],
    rejectionReason: null,
    approvedAt: null,
    deployedAt: null,
    updatedAt: now,
  });
}

export function approveProductionRelease(
  release: ProductionRelease,
  actorId: string,
  now: string,
): ProductionRelease {
  if (release.status !== "pending_approval") {
    throw new ReleaseGateError("Only pending releases can be approved", [
      `current status: ${release.status}`,
    ]);
  }
  if (actorId === release.createdBy) {
    throw new ReleaseGateError("Release authors cannot self-approve", [
      "author and approver are the same actor",
    ]);
  }
  if (release.approvalActorIds.includes(actorId)) {
    throw new ReleaseGateError("An approver can approve only once", [
      "duplicate approver",
    ]);
  }
  const approvalActorIds = [...release.approvalActorIds, actorId];
  const approved = approvalActorIds.length === 2;
  return ProductionReleaseSchema.parse({
    ...release,
    approvalActorIds,
    status: approved ? "approved" : "pending_approval",
    approvedAt: approved ? now : null,
    updatedAt: now,
  });
}

export function rejectProductionRelease(
  release: ProductionRelease,
  actorId: string,
  reason: string,
  now: string,
): ProductionRelease {
  if (release.status !== "pending_approval") {
    throw new ReleaseGateError("Only pending releases can be rejected", [
      `current status: ${release.status}`,
    ]);
  }
  if (actorId === release.createdBy) {
    throw new ReleaseGateError(
      "Release authors cannot review their own release",
      ["author and reviewer are the same actor"],
    );
  }
  return ProductionReleaseSchema.parse({
    ...release,
    status: "rejected",
    rejectionReason: reason,
    updatedAt: now,
  });
}

export function deployProductionRelease(
  release: ProductionRelease,
  actorId: string,
  now: string,
): ProductionRelease {
  if (release.status !== "approved") {
    throw new ReleaseGateError("Only approved releases can be deployed", [
      `current status: ${release.status}`,
    ]);
  }
  if (!release.approvalActorIds.includes(actorId)) {
    throw new ReleaseGateError(
      "Deployment requires an approving administrator",
      ["deployment actor did not approve this release"],
    );
  }
  return ProductionReleaseSchema.parse({
    ...release,
    status: "deployed",
    deployedAt: now,
    updatedAt: now,
  });
}

export function rollbackProductionRelease(
  release: ProductionRelease,
  actorId: string,
  now: string,
): ProductionRelease {
  if (release.status !== "deployed") {
    throw new ReleaseGateError("Only deployed releases can be rolled back", [
      `current status: ${release.status}`,
    ]);
  }
  if (actorId === release.createdBy) {
    throw new ReleaseGateError(
      "Release authors cannot unilaterally roll back",
      ["author and rollback actor are the same actor"],
    );
  }
  return ProductionReleaseSchema.parse({
    ...release,
    status: "rolled_back",
    updatedAt: now,
  });
}
