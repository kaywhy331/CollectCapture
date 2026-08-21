import type {
  ConnectorManifest,
  DiagnosticArtifact,
  FeatureFlag,
  ProductionRelease,
  ReleaseEvidence,
  SupportAccessGrant,
} from "@localclear/domain";
import { environment } from "./environment";

export interface ConnectorHealth {
  platform: string;
  connectorVersion: string;
  appVersion: string;
  total: number;
  published: number;
  failed: number;
  paused: number;
  active: number;
  failureTypes: Record<string, number>;
  successRate: number | null;
}

export interface OperationsAlert {
  severity: "warning" | "critical";
  code: string;
  message: string;
  platform: string | null;
}

export interface OperationsDashboard {
  generatedAt: string;
  windowStartedAt: string;
  connectors: ConnectorManifest[];
  featureFlags: FeatureFlag[];
  releases: ProductionRelease[];
  health: ConnectorHealth[];
  alerts: OperationsAlert[];
  duplicateBlocks: number;
}

export interface ConnectorUpdate {
  enabled: boolean;
  killSwitchReason: string | null;
  policyStatus: ConnectorManifest["policyStatus"];
  productionMethod: string | null;
  approvalEvidenceUrl: string | null;
  owner: string;
  supportedAppVersions: string[];
  canaryTestId: string | null;
  changeSummary: string;
}

export interface FeatureFlagUpdate {
  enabled: boolean;
  killSwitchReason: string | null;
  owner: string;
  changeSummary: string;
}

export interface ProductionReleaseCreate {
  version: string;
  target: ProductionRelease["target"];
  summary: string;
  connectorIds: string[];
  evidence: ReleaseEvidence[];
}

export interface SupportSession {
  grant: SupportAccessGrant;
  devices: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  diagnostics: Array<DiagnosticArtifact & { readUrl: string | null }>;
}

async function request<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(new URL(path, environment.apiUrl), {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json()) as {
    message?: string;
  };
  if (!response.ok) {
    throw new Error(payload.message ?? "Operations request failed");
  }
  return payload as T;
}

export const operationsApi = {
  dashboard(accessToken: string) {
    return request<OperationsDashboard>("/v1/admin/operations", accessToken);
  },
  updateConnector(
    accessToken: string,
    connectorId: string,
    update: ConnectorUpdate,
  ) {
    return request<{ connector: ConnectorManifest }>(
      `/v1/admin/connectors/${encodeURIComponent(connectorId)}`,
      accessToken,
      { method: "PATCH", body: JSON.stringify(update) },
    );
  },
  updateFeatureFlag(
    accessToken: string,
    key: string,
    update: FeatureFlagUpdate,
  ) {
    return request<{ featureFlag: FeatureFlag }>(
      `/v1/admin/feature-flags/${encodeURIComponent(key)}`,
      accessToken,
      { method: "PATCH", body: JSON.stringify(update) },
    );
  },
  createRelease(accessToken: string, release: ProductionReleaseCreate) {
    return request<{ release: ProductionRelease }>(
      "/v1/admin/releases",
      accessToken,
      { method: "POST", body: JSON.stringify(release) },
    );
  },
  submitRelease(accessToken: string, releaseId: string) {
    return request<{ release: ProductionRelease }>(
      `/v1/admin/releases/${encodeURIComponent(releaseId)}/submit`,
      accessToken,
      { method: "POST" },
    );
  },
  reviewRelease(
    accessToken: string,
    releaseId: string,
    action: "approve" | "reject" | "deploy" | "rollback",
    reason?: string,
  ) {
    return request<{ release: ProductionRelease }>(
      `/v1/admin/releases/${encodeURIComponent(releaseId)}/review`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
      },
    );
  },
  activeSupportGrants(accessToken: string) {
    return request<{ grants: SupportAccessGrant[] }>(
      "/v1/admin/support-grants",
      accessToken,
    );
  },
  supportSession(accessToken: string, grantId: string) {
    return request<SupportSession>(
      `/v1/admin/support-grants/${encodeURIComponent(grantId)}/session`,
      accessToken,
    );
  },
};
