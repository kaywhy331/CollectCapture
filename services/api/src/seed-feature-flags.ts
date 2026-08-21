import { FeatureFlagSchema, type FeatureFlag } from "@localclear/domain";
import type { Repository } from "./repository.js";

const changedAt = "2026-08-20T00:00:00.000Z";

function enabledFlag(
  key: string,
  description: string,
  owner: string,
): FeatureFlag {
  return FeatureFlagSchema.parse({
    key,
    description,
    enabled: true,
    killSwitchReason: null,
    owner,
    version: 1,
    updatedAt: changedAt,
    changeLog: [
      {
        version: 1,
        changedAt,
        changedBy: "localclear-bootstrap",
        summary: "Initial guarded feature release",
      },
    ],
  });
}

export const INITIAL_FEATURE_FLAGS: readonly FeatureFlag[] = [
  enabledFlag(
    "publishing_enabled",
    "Allow new publish, edit, delist, and mark-sold jobs",
    "publishing-engineering",
  ),
  enabledFlag(
    "ai_enrichment_enabled",
    "Allow photo intelligence requests",
    "applied-ai",
  ),
  enabledFlag(
    "buyer_assistance_enabled",
    "Allow buyer-task drafting and meetup assistance",
    "product",
  ),
  enabledFlag(
    "diagnostic_uploads_enabled",
    "Allow consented, privacy-scanned diagnostic artifact submission",
    "security",
  ),
];

export async function seedInitialFeatureFlags(
  upsert: (flag: FeatureFlag) => Promise<unknown>,
): Promise<void> {
  for (const flag of INITIAL_FEATURE_FLAGS) await upsert(flag);
}

export async function seedMissingFeatureFlags(
  repository: Repository,
): Promise<void> {
  for (const flag of INITIAL_FEATURE_FLAGS) {
    if (!(await repository.getFeatureFlag(flag.key))) {
      await repository.upsertFeatureFlag(flag);
    }
  }
}
