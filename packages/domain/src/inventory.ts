import type {
  ConnectorCapability,
  ItemStatus,
  PlatformListing,
} from "./schemas.js";

type PlatformListingStatus = PlatformListing["status"];

const terminalClearingStates = new Set<ItemStatus>([
  "sold",
  "given_away",
  "donated",
  "recycled",
  "discarded",
]);

const allowedItemTransitions: Readonly<
  Record<ItemStatus, readonly ItemStatus[]>
> = {
  captured: [
    "draft",
    "given_away",
    "donated",
    "recycled",
    "discarded",
    "archived",
  ],
  draft: [
    "ready",
    "given_away",
    "donated",
    "recycled",
    "discarded",
    "archived",
  ],
  ready: [
    "draft",
    "publishing",
    "given_away",
    "donated",
    "recycled",
    "discarded",
    "archived",
  ],
  publishing: [
    "partially_live",
    "live",
    "ready",
    "sold",
    "given_away",
    "donated",
    "recycled",
    "discarded",
    "archived",
  ],
  partially_live: [
    "publishing",
    "live",
    "reserved",
    "sold",
    "given_away",
    "donated",
    "recycled",
    "discarded",
    "archived",
  ],
  live: [
    "publishing",
    "reserved",
    "sold",
    "given_away",
    "donated",
    "recycled",
    "discarded",
    "archived",
  ],
  reserved: ["live", "sold", "given_away", "archived"],
  sold: ["archived"],
  given_away: ["archived"],
  donated: ["archived"],
  recycled: ["archived"],
  discarded: ["archived"],
  archived: ["draft"],
};

export class InvalidItemTransitionError extends Error {
  constructor(from: ItemStatus, to: ItemStatus) {
    super(`Item cannot transition from ${from} to ${to}`);
    this.name = "InvalidItemTransitionError";
  }
}

export function transitionItemStatus(
  from: ItemStatus,
  to: ItemStatus,
): ItemStatus {
  if (from === to) return to;
  if (!allowedItemTransitions[from].includes(to)) {
    throw new InvalidItemTransitionError(from, to);
  }
  return to;
}

export function isClearedItemStatus(status: ItemStatus): boolean {
  return terminalClearingStates.has(status);
}

export function deriveItemStatus(
  listings: readonly Pick<PlatformListing, "status">[],
  current: ItemStatus,
): ItemStatus {
  if (
    isClearedItemStatus(current) ||
    current === "archived" ||
    current === "reserved"
  ) {
    return current;
  }
  if (listings.length === 0) {
    return current;
  }

  const statuses = listings.map((listing) => listing.status);
  if (statuses.every((status) => status === "live")) {
    return "live";
  }
  if (statuses.some((status) => status === "live" || status === "reserved")) {
    return "partially_live";
  }
  if (statuses.some((status) => status === "publishing")) {
    return "publishing";
  }
  return current;
}

export interface ClosureListing {
  platformListingId: string;
  platform: string;
  status: PlatformListingStatus;
  capabilities: readonly ConnectorCapability[];
  connectorAllowed: boolean;
}

export interface ClosureOperation {
  platformListingId: string;
  platform: string;
  action: "mark_sold" | "delist";
}

export interface ClosureException {
  platformListingId: string;
  platform: string;
  reason: "connector_blocked" | "manual_action_required";
}

export interface InventoryClosurePlan {
  operations: ClosureOperation[];
  exceptionTask: {
    title: string;
    exceptions: ClosureException[];
  } | null;
}

export function planInventoryClosure(
  listings: readonly ClosureListing[],
  outcome: Extract<
    ItemStatus,
    "sold" | "given_away" | "donated" | "recycled" | "discarded"
  >,
): InventoryClosurePlan {
  const operations: ClosureOperation[] = [];
  const exceptions: ClosureException[] = [];

  for (const listing of listings) {
    if (["delisted", "sold", "not_published"].includes(listing.status)) {
      continue;
    }
    if (!listing.connectorAllowed) {
      exceptions.push({
        platformListingId: listing.platformListingId,
        platform: listing.platform,
        reason: "connector_blocked",
      });
      continue;
    }
    if (outcome === "sold" && listing.capabilities.includes("mark_sold")) {
      operations.push({
        platformListingId: listing.platformListingId,
        platform: listing.platform,
        action: "mark_sold",
      });
      continue;
    }
    if (listing.capabilities.includes("delist")) {
      operations.push({
        platformListingId: listing.platformListingId,
        platform: listing.platform,
        action: "delist",
      });
      continue;
    }
    exceptions.push({
      platformListingId: listing.platformListingId,
      platform: listing.platform,
      reason: "manual_action_required",
    });
  }

  return {
    operations,
    exceptionTask:
      exceptions.length === 0
        ? null
        : {
            title: `Finish removing this ${outcome.replace("_", " ")} item`,
            exceptions,
          },
  };
}

export interface DuplicateCandidate {
  id: string;
  normalizedTitle: string;
  barcode: string | null;
  imageFingerprint: string | null;
  brand: string | null;
  model: string | null;
}

export interface DuplicateMatch {
  itemId: string;
  score: number;
  reasons: string[];
}

export function findLikelyDuplicates(
  candidate: DuplicateCandidate,
  inventory: readonly DuplicateCandidate[],
  threshold = 0.7,
): DuplicateMatch[] {
  return inventory
    .filter((item) => item.id !== candidate.id)
    .map((item) => {
      let score = 0;
      const reasons: string[] = [];
      if (candidate.barcode && item.barcode === candidate.barcode) {
        score += 0.8;
        reasons.push("matching barcode");
      }
      if (
        candidate.imageFingerprint &&
        item.imageFingerprint === candidate.imageFingerprint
      ) {
        score += 0.75;
        reasons.push("matching lead image");
      }
      if (
        candidate.brand &&
        candidate.model &&
        item.brand?.toLowerCase() === candidate.brand.toLowerCase() &&
        item.model?.toLowerCase() === candidate.model.toLowerCase()
      ) {
        score += 0.65;
        reasons.push("matching brand and model");
      }
      if (item.normalizedTitle === candidate.normalizedTitle) {
        score += 0.25;
        reasons.push("matching title");
      }
      return { itemId: item.id, score: Math.min(1, score), reasons };
    })
    .filter((match) => match.score >= threshold)
    .sort((left, right) => right.score - left.score);
}
