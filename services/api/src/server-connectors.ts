import type {
  CanonicalListing,
  ConnectorManifest,
  Household,
  PlatformListing,
  PlatformListingVariant,
  PublishingJob,
} from "@localclear/domain";
import type { StoredItem } from "./repository.js";

export interface ServerConnectorContext {
  job: PublishingJob;
  connector: ConnectorManifest;
  household: Household;
  item: StoredItem;
  listing: CanonicalListing;
  variant: PlatformListingVariant;
  platformListing: PlatformListing | null;
}

export type ServerConnectorResult =
  | {
      status: "published";
      result?: {
        externalListingId: string | null;
        externalUrl: string | null;
        platformTitle?: string;
        platformPrice?: { amountCents: number; currency: string };
      };
    }
  | {
      status: "user_confirmation";
      reasonCode: string;
      detail: string;
      exportPayload: Record<string, unknown>;
    }
  | {
      status: "retryable_failure";
      reasonCode: string;
      detail: string;
    }
  | { status: "fatal_failure"; reasonCode: string; detail: string };

export interface ServerConnectorExecutor {
  execute(context: ServerConnectorContext): Promise<ServerConnectorResult>;
}

export class GovernedServerConnectorExecutor implements ServerConnectorExecutor {
  async execute(
    context: ServerConnectorContext,
  ): Promise<ServerConnectorResult> {
    if (context.connector.id === "sandbox-local-api") {
      return executeSandboxApi(context);
    }
    if (context.connector.id === "sandbox-share-export") {
      if (context.job.commandAction !== "publish") {
        return {
          status: "fatal_failure",
          reasonCode: "CAPABILITY_NOT_SUPPORTED",
          detail:
            "The share-export connector only supports new listing packages.",
        };
      }
      return {
        status: "user_confirmation",
        reasonCode: "IMPORT_PACKAGE_READY",
        detail:
          "Download the prepared listing package, import it through the permitted platform flow, then confirm the live listing ID or URL.",
        exportPayload: {
          schemaVersion: 1,
          platform: context.connector.platform,
          connectorVersion: context.connector.version,
          itemId: context.item.id,
          listingVersion: context.listing.version,
          title: context.variant.title,
          description: context.variant.description,
          category: context.variant.category,
          price: context.variant.price,
          fields: context.variant.fields,
          media: context.item.media
            .slice()
            .sort((left, right) => left.order - right.order)
            .map((asset) => ({
              assetId: asset.id,
              order: asset.order,
              sha256: asset.contentSha256,
            })),
        },
      };
    }
    return {
      status: "fatal_failure",
      reasonCode: "SERVER_EXECUTOR_UNAVAILABLE",
      detail:
        "No reviewed server-side executor is installed for this connector definition.",
    };
  }
}

function executeSandboxApi(
  context: ServerConnectorContext,
): ServerConnectorResult {
  if (context.job.commandAction === "publish") {
    return {
      status: "published",
      result: {
        externalListingId: `sandbox-api-${context.job.id}`,
        externalUrl: `https://sandbox-local-api.invalid/listings/${context.job.id}`,
        platformTitle: context.variant.title,
        platformPrice: context.variant.price,
      },
    };
  }
  if (!context.platformListing?.externalListingId) {
    return {
      status: "fatal_failure",
      reasonCode: "EXTERNAL_LISTING_ID_MISSING",
      detail: "The existing platform listing identifier is required.",
    };
  }
  return {
    status: "published",
    result: {
      externalListingId: context.platformListing.externalListingId,
      externalUrl: context.platformListing.externalUrl,
      platformTitle: context.variant.title,
      platformPrice: context.variant.price,
    },
  };
}
