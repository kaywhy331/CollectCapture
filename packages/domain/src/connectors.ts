import { z } from "zod";
import {
  ConnectorCapabilitySchema,
  ConnectorKindSchema,
  ConnectorPolicyStatusSchema,
  TimestampSchema,
  type ConnectorCapability,
} from "./schemas.js";

export const ConnectorCapabilitiesSchema = z
  .object({
    publish: z.boolean(),
    edit: z.boolean(),
    delist: z.boolean(),
    mark_sold: z.boolean(),
    message_read: z.boolean(),
    message_send: z.boolean(),
    import: z.boolean(),
  })
  .strict();
export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilitiesSchema>;

export const ConnectorChangeSchema = z
  .object({
    version: z.string().trim().min(1).max(64),
    changedAt: TimestampSchema,
    changedBy: z.string().trim().min(1).max(128),
    summary: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const ConnectorManifestSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    platform: z.string().trim().min(1).max(80),
    kind: ConnectorKindSchema,
    version: z.string().trim().min(1).max(64),
    definitionVersion: z.number().int().min(1),
    enabled: z.boolean(),
    killSwitchReason: z.string().trim().min(1).max(500).nullable(),
    policyStatus: ConnectorPolicyStatusSchema,
    productionMethod: z.string().trim().min(1).max(500).nullable(),
    approvalEvidenceUrl: z.url().nullable(),
    policyReviewedAt: TimestampSchema.nullable(),
    owner: z.string().trim().min(1).max(160),
    capabilities: ConnectorCapabilitiesSchema,
    supportedAppVersions: z.array(z.string().trim().min(1).max(64)).max(100),
    requiredFields: z.array(z.string().trim().min(1).max(160)).max(100),
    categoryMappings: z.record(z.string(), z.string().trim().min(1).max(240)),
    fieldMappings: z
      .record(z.string(), z.string().trim().min(1).max(240))
      .default({}),
    titleMaxLength: z.number().int().min(20).max(500).default(100),
    descriptionMaxLength: z.number().int().min(100).max(10_000).default(5_000),
    rateLimitPerMinute: z.number().int().min(1).max(1_000),
    dailyListingCap: z.number().int().min(1).max(100_000),
    canaryTestId: z.string().trim().min(1).max(160).nullable(),
    changeLog: z.array(ConnectorChangeSchema).min(1),
  })
  .strict();
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

export type ConnectorEnvironment = "internal" | "beta" | "production";

export interface ConnectorGateInput {
  manifest: ConnectorManifest;
  capability: ConnectorCapability;
  environment: ConnectorEnvironment;
  appVersion?: string;
}

export interface ConnectorGateResult {
  allowed: boolean;
  blockers: string[];
}

export function evaluateConnectorGate(
  input: ConnectorGateInput,
): ConnectorGateResult {
  const { manifest, capability, environment, appVersion } = input;
  const blockers: string[] = [];

  if (!manifest.enabled) {
    blockers.push(
      manifest.killSwitchReason ??
        "Connector is disabled by its remote kill switch",
    );
  }
  if (!manifest.capabilities[capability]) {
    blockers.push(`Connector does not declare the ${capability} capability`);
  }
  if (appVersion && !manifest.supportedAppVersions.includes(appVersion)) {
    blockers.push(`App version ${appVersion} is not supported`);
  }
  if (
    manifest.supportedAppVersions.length === 0 &&
    manifest.kind === "android"
  ) {
    blockers.push("Android connector has no supported app versions");
  }

  if (environment === "internal") {
    if (manifest.policyStatus === "disabled") {
      blockers.push("Policy status is disabled");
    }
  } else if (manifest.policyStatus !== "approved") {
    blockers.push(
      `Policy status ${manifest.policyStatus} is not approved for ${environment}`,
    );
  }

  if (environment !== "internal") {
    if (!manifest.productionMethod) {
      blockers.push("No permitted production method is documented");
    }
    if (!manifest.approvalEvidenceUrl) {
      blockers.push("No approval or permission evidence is attached");
    }
    if (!manifest.policyReviewedAt) {
      blockers.push("Policy review date is missing");
    }
    if (!manifest.canaryTestId) {
      blockers.push("No app-update canary test is configured");
    }
  }

  return { allowed: blockers.length === 0, blockers };
}

export class ConnectorBlockedError extends Error {
  constructor(
    readonly platform: string,
    readonly blockers: string[],
  ) {
    super(`${platform} connector blocked: ${blockers.join("; ")}`);
    this.name = "ConnectorBlockedError";
  }
}

export function assertConnectorAllowed(input: ConnectorGateInput): void {
  const result = evaluateConnectorGate(input);
  if (!result.allowed) {
    throw new ConnectorBlockedError(input.manifest.platform, result.blockers);
  }
}

export const RESTRICTED_PLATFORM_POLICIES = Object.freeze({
  offerup: {
    policyStatus: "disabled",
    reason: "Written approval is required before public automation",
  },
  craigslist: {
    policyStatus: "disabled",
    reason:
      "A license or written authorization is required before automated posting",
  },
  ebay: {
    policyStatus: "disabled",
    reason: "Optional expansion channel; disabled by default",
  },
} as const);

export const CONNECTOR_CAPABILITIES = ConnectorCapabilitySchema.options;
