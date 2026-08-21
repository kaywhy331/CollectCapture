import {
  createHash,
  createPrivateKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  canonicalJson,
  signDeviceCommand,
  type DeviceCommandPayload,
  type SignedDeviceCommand,
} from "@localclear/device-protocol";
import type {
  CanonicalListing,
  Household,
  Item,
  PlatformListingVariant,
  PlatformListing,
  PublishingJob,
} from "@localclear/domain";
import type { MediaReadUrlProvider } from "./intelligence.js";

export interface DeviceCommandBuildInput {
  job: PublishingJob;
  item: Item;
  household: Household;
  listing: CanonicalListing;
  variant: PlatformListingVariant;
  platformListing: PlatformListing | null;
}

export interface DeviceCommandFactory {
  create(input: DeviceCommandBuildInput): Promise<SignedDeviceCommand>;
}

export class DeviceCommandUnavailableError extends Error {
  constructor() {
    super("Device command signing is not configured");
    this.name = "DeviceCommandUnavailableError";
  }
}

export class UnavailableDeviceCommandFactory implements DeviceCommandFactory {
  async create(): Promise<SignedDeviceCommand> {
    throw new DeviceCommandUnavailableError();
  }
}

export class SignedDeviceCommandFactory implements DeviceCommandFactory {
  readonly #keyId: string;
  readonly #privateKey: KeyObject;
  readonly #mediaReadUrlProvider: MediaReadUrlProvider;
  readonly #now: () => Date;

  constructor(options: {
    keyId: string;
    privateKey: string;
    mediaReadUrlProvider: MediaReadUrlProvider;
    now?: () => Date;
  }) {
    this.#keyId = options.keyId;
    const privateKey = createPrivateKey(options.privateKey);
    const curve = privateKey.asymmetricKeyDetails?.namedCurve;
    if (
      privateKey.asymmetricKeyType !== "ec" ||
      !["prime256v1", "secp256r1", "P-256"].includes(curve ?? "")
    ) {
      throw new Error(
        "Device command signing private key must use P-256 ECDSA",
      );
    }
    this.#privateKey = privateKey;
    this.#mediaReadUrlProvider = options.mediaReadUrlProvider;
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: DeviceCommandBuildInput): Promise<SignedDeviceCommand> {
    if (!input.job.deviceId) {
      throw new Error("A Seller Hub command must target one device");
    }
    if (!input.job.platformAppVersion) {
      throw new Error(
        "A Seller Hub command must snapshot the platform app version",
      );
    }
    const now = this.#now();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const base = {
      version: 1 as const,
      jobId: input.job.id,
      userId: input.household.ownerId,
      householdId: input.household.id,
      deviceId: input.job.deviceId,
      itemId: input.item.id,
      platform: input.job.platform,
      listingVersion: input.job.listingVersion,
      connectorVersion: input.job.connectorVersion,
      platformAppVersion: input.job.platformAppVersion,
      issuedAt,
      expiresAt,
      nonce: randomBytes(24).toString("base64url"),
    };
    let payload: DeviceCommandPayload;

    switch (input.job.commandAction) {
      case "publish": {
        const media = await Promise.all(
          input.item.media.map(async (asset) => ({
            assetId: asset.id,
            downloadUrl: await this.#mediaReadUrlProvider.createReadUrl(
              asset.storagePath,
              5 * 60,
            ),
            sha256: asset.contentSha256,
            expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
            order: asset.order,
          })),
        );
        payload = {
          ...base,
          action: "publish",
          parameters: {
            canonicalListingId: input.listing.id,
            canonicalListingDigest: createHash("sha256")
              .update(canonicalJson(input.listing))
              .digest("hex"),
            title: input.variant.title,
            description: input.variant.description,
            priceCents: input.variant.price.amountCents,
            currency: input.variant.price.currency,
            category: input.variant.category,
            condition: input.item.condition.replaceAll("_", " "),
            approximateLocation: input.listing.location.displayArea,
            platformFields: scalarFields(input.variant.fields),
            media,
          },
        };
        break;
      }
      case "update_fields":
        payload = {
          ...base,
          action: "update_fields",
          parameters: {
            externalListingId: requireExternalListingId(input.platformListing),
            fields: {
              title: input.variant.title,
              description: input.variant.description,
              priceCents: input.variant.price.amountCents,
              category: input.variant.category,
              condition: input.item.condition.replaceAll("_", " "),
              approximateLocation: input.listing.location.displayArea,
            },
          },
        };
        break;
      case "mark_sold":
      case "delist":
        payload = {
          ...base,
          action: input.job.commandAction,
          parameters: {
            externalListingId: requireExternalListingId(input.platformListing),
          },
        };
        break;
      case "check_connection":
      case "resume":
        payload = {
          ...base,
          action: input.job.commandAction,
          parameters: {},
        };
        break;
      case "pause":
        payload = {
          ...base,
          action: "pause",
          parameters: { reasonCode: input.job.errorCode ?? "USER_PAUSED" },
        };
        break;
    }
    return signDeviceCommand(payload, {
      keyId: this.#keyId,
      privateKey: this.#privateKey,
    });
  }
}

function requireExternalListingId(listing: PlatformListing | null): string {
  if (!listing?.externalListingId) {
    throw new Error("The platform listing ID is required for this command");
  }
  return listing.externalListingId;
}

function scalarFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string | number | boolean] =>
        ["string", "number", "boolean"].includes(typeof entry[1]),
    ),
  );
}
