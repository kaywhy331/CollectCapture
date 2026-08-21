import { z } from "zod";
import {
  assertSpecificationsPublishable,
  classifySpecificationsForPublishing,
} from "./listings.js";
import {
  MoneySchema,
  TimestampSchema,
  type CanonicalListing,
  type Household,
  type Item,
} from "./schemas.js";
import type { ConnectorManifest } from "./connectors.js";

export const PlatformListingVariantSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    householdId: z.string().trim().min(1).max(128),
    itemId: z.string().trim().min(1).max(128),
    listingVersion: z.number().int().min(1),
    connectorId: z.string().trim().min(1).max(128),
    connectorVersion: z.string().trim().min(1).max(64),
    platform: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(10_000),
    category: z.string().trim().min(1).max(240),
    price: MoneySchema,
    fields: z.record(z.string(), z.unknown()),
    generatedAt: TimestampSchema,
  })
  .strict();
export type PlatformListingVariant = z.infer<
  typeof PlatformListingVariantSchema
>;

export class MissingConnectorFieldsError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Connector fields are missing: ${fields.join(", ")}`);
    this.name = "MissingConnectorFieldsError";
  }
}

export function createPlatformListingVariant(input: {
  id: string;
  item: Item;
  listing: CanonicalListing;
  household: Household;
  connector: ConnectorManifest;
  generatedAt: string;
}): PlatformListingVariant {
  assertSpecificationsPublishable(input.listing.specifications);
  const publishable = classifySpecificationsForPublishing(
    input.listing.specifications,
  ).publishable;
  const categoryKey = input.item.category.trim().toLowerCase();
  const category =
    input.connector.categoryMappings[categoryKey] ??
    input.connector.categoryMappings.default ??
    input.item.category;
  const exchange = input.listing.exchangeOptions
    .map(formatExchangeOption)
    .join(", ");
  const payment = formatPaymentWording(input.listing.paymentWording);
  const title = truncatePlainText(
    input.listing.title,
    input.connector.titleMaxLength,
  );
  const description = truncatePlainText(
    [
      input.listing.description,
      input.listing.conditionSummary,
      `Exchange: ${exchange}.`,
      `Payment: ${payment}. Payment remains outside LocalClear.`,
    ].join("\n\n"),
    input.connector.descriptionMaxLength,
  );
  const canonicalFields: Record<string, unknown> = {
    title,
    description,
    price: input.listing.askingPrice,
    photos: input.item.media
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((asset) => asset.id),
    condition: input.item.condition,
    category,
    location: {
      displayArea: input.listing.location.displayArea,
      zipCode: input.listing.location.zipCode.slice(0, 3),
      radiusMiles: input.listing.location.radiusMiles,
    },
    exchange_options: input.listing.exchangeOptions,
    payment_wording: input.listing.paymentWording,
    specifications: Object.fromEntries(
      Object.entries(publishable).map(([key, value]) => [key, value.value]),
    ),
    brand: input.item.brand,
    model: input.item.model,
    dimensions: Object.fromEntries(
      Object.entries(input.item.dimensions)
        .filter(([, value]) => value.provenance !== "inferred")
        .map(([key, value]) => [key, value.value]),
    ),
    accessories: input.item.accessories,
    defects: input.item.defects,
  };
  const fields = Object.fromEntries(
    Object.entries(canonicalFields).map(([key, value]) => [
      input.connector.fieldMappings[key] ?? key,
      value,
    ]),
  );
  const missing = input.connector.requiredFields.filter((field) => {
    const mapped = input.connector.fieldMappings[field] ?? field;
    return isMissing(fields[mapped]);
  });
  if (missing.length > 0) throw new MissingConnectorFieldsError(missing);

  return PlatformListingVariantSchema.parse({
    id: input.id,
    householdId: input.item.householdId,
    itemId: input.item.id,
    listingVersion: input.listing.version,
    connectorId: input.connector.id,
    connectorVersion: input.connector.version,
    platform: input.connector.platform,
    title,
    description,
    category,
    price: input.listing.askingPrice,
    fields,
    generatedAt: input.generatedAt,
  });
}

function isMissing(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function truncatePlainText(value: string, maximum: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maximum) return trimmed;
  if (maximum <= 1) return trimmed.slice(0, maximum);
  return `${trimmed.slice(0, maximum - 1).trimEnd()}…`;
}

function formatExchangeOption(
  value: CanonicalListing["exchangeOptions"][number],
) {
  return {
    public_meetup: "public meetup",
    porch_pickup: "porch pickup",
    buyer_pickup: "buyer pickup for large items",
    local_delivery: "optional local delivery",
    decide_per_item: "arrangements decided per item",
  }[value];
}

function formatPaymentWording(value: CanonicalListing["paymentWording"]) {
  return {
    cash_preferred: "cash preferred",
    external_apps_accepted: "external payment apps accepted",
    decide_at_meetup: "decide at meetup",
  }[value];
}
