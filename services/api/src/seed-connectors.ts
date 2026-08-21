import {
  ConnectorManifestSchema,
  type ConnectorManifest,
} from "@localclear/domain";
import type { Repository } from "./repository.js";

const changedAt = "2026-08-20T00:00:00.000Z";

function manifest(
  input: Omit<
    ConnectorManifest,
    "changeLog" | "fieldMappings" | "titleMaxLength" | "descriptionMaxLength"
  > & {
    summary: string;
    fieldMappings?: ConnectorManifest["fieldMappings"];
    titleMaxLength?: number;
    descriptionMaxLength?: number;
  },
): ConnectorManifest {
  const { summary, ...definition } = input;
  return ConnectorManifestSchema.parse({
    ...definition,
    changeLog: [
      {
        version: input.version,
        changedAt,
        changedBy: "localclear-bootstrap",
        summary,
      },
    ],
  });
}

const noMessages = { message_read: false, message_send: false } as const;

export const INITIAL_CONNECTORS: readonly ConnectorManifest[] = [
  manifest({
    id: "sandbox-local-api",
    platform: "Sandbox Local API",
    kind: "api",
    version: "1.0.0",
    definitionVersion: 1,
    enabled: true,
    killSwitchReason: null,
    policyStatus: "internal_only",
    productionMethod: null,
    approvalEvidenceUrl: null,
    policyReviewedAt: changedAt,
    owner: "engineering",
    capabilities: {
      publish: true,
      edit: true,
      delist: true,
      mark_sold: true,
      message_read: true,
      message_send: true,
      import: false,
    },
    supportedAppVersions: [],
    requiredFields: ["title", "description", "price", "photos"],
    categoryMappings: { default: "general" },
    rateLimitPerMinute: 10,
    dailyListingCap: 250,
    canaryTestId: "sandbox-api-canary",
    summary: "Internal official-API connector pattern",
  }),
  manifest({
    id: "sandbox-seller-hub",
    platform: "Sandbox Seller Hub",
    kind: "android",
    version: "1.0.0",
    definitionVersion: 1,
    enabled: true,
    killSwitchReason: null,
    policyStatus: "internal_only",
    productionMethod: null,
    approvalEvidenceUrl: null,
    policyReviewedAt: changedAt,
    owner: "seller-hub-engineering",
    capabilities: {
      publish: true,
      edit: true,
      delist: true,
      mark_sold: true,
      ...noMessages,
      import: false,
    },
    supportedAppVersions: ["1.0.0"],
    requiredFields: ["title", "description", "price", "photos"],
    categoryMappings: { default: "general" },
    rateLimitPerMinute: 2,
    dailyListingCap: 25,
    canaryTestId: "sandbox-hub-canary",
    summary: "Internal physical-Android deterministic connector pattern",
  }),
  manifest({
    id: "sandbox-share-export",
    platform: "Sandbox Share Export",
    kind: "import",
    version: "1.0.0",
    definitionVersion: 1,
    enabled: true,
    killSwitchReason: null,
    policyStatus: "internal_only",
    productionMethod: null,
    approvalEvidenceUrl: null,
    policyReviewedAt: changedAt,
    owner: "integrations",
    capabilities: {
      publish: true,
      edit: false,
      delist: false,
      mark_sold: false,
      ...noMessages,
      import: true,
    },
    supportedAppVersions: [],
    requiredFields: ["title", "description", "price"],
    categoryMappings: { default: "general" },
    rateLimitPerMinute: 20,
    dailyListingCap: 500,
    canaryTestId: "sandbox-import-canary",
    summary: "Internal browser/import connector pattern",
  }),
  ...[
    [
      "offerup",
      "OfferUp",
      "Written approval is required before public automation",
    ],
    [
      "craigslist",
      "Craigslist",
      "A license or written authorization is required",
    ],
    [
      "facebook-marketplace",
      "Facebook Marketplace",
      "Platform and legal approval are required",
    ],
    [
      "nextdoor",
      "Nextdoor For Sale & Free",
      "Nextdoor Publish API approval is required",
    ],
    ["ebay", "eBay", "Optional reach extension; disabled by default"],
  ].map(([id, platform, reason]) =>
    manifest({
      id: id ?? "disabled",
      platform: platform ?? "Disabled connector",
      kind: "api",
      version: "0.0.0",
      definitionVersion: 1,
      enabled: false,
      killSwitchReason: reason ?? "Approval required",
      policyStatus: "disabled",
      productionMethod: null,
      approvalEvidenceUrl: null,
      policyReviewedAt: changedAt,
      owner: "partnerships",
      capabilities: {
        publish: false,
        edit: false,
        delist: false,
        mark_sold: false,
        ...noMessages,
        import: false,
      },
      supportedAppVersions: [],
      requiredFields: [],
      categoryMappings: {},
      rateLimitPerMinute: 1,
      dailyListingCap: 1,
      canaryTestId: null,
      summary: reason ?? "Disabled pending approval",
    }),
  ),
];

export async function seedInitialConnectors(
  upsert: (manifest: ConnectorManifest) => Promise<unknown>,
): Promise<void> {
  for (const connector of INITIAL_CONNECTORS) {
    await upsert(connector);
  }
}

export async function seedMissingConnectors(
  repository: Repository,
): Promise<void> {
  for (const connector of INITIAL_CONNECTORS) {
    if (!(await repository.getConnector(connector.platform))) {
      await repository.upsertConnector(connector);
    }
  }
}
