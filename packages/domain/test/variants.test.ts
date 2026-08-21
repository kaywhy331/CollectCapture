import { describe, expect, it } from "vitest";
import {
  ConnectorManifestSchema,
  createPlatformListingVariant,
  type CanonicalListing,
  type Household,
  type Item,
} from "../src/index.js";

const createdAt = "2026-08-20T12:00:00.000Z";
const household = {
  id: "household-1",
  ownerId: "owner-1",
  name: "Home",
  goal: "sell_few_items",
  zipCode: "94107",
  sellingRadiusMiles: 10,
  exchangePreferences: ["public_meetup"],
  paymentWording: "cash_preferred",
  availability: [],
  preferredMeetupLocations: [],
  priceRules: {
    defaultMinimumOfferPercent: 70,
    defaultHoldMinutes: 120,
    acceptsTrades: false,
  },
  timezone: "America/Los_Angeles",
  createdAt,
  updatedAt: createdAt,
} satisfies Household;

const item = {
  id: "item-1",
  householdId: household.id,
  title: "Oak side table",
  category: "Furniture",
  brand: null,
  model: null,
  condition: "good",
  dimensions: {},
  specifications: {},
  accessories: [],
  defects: ["Small surface scratch"],
  storageLocation: "Garage A",
  identification: {
    itemType: "side table",
    category: "Furniture",
    brand: null,
    model: null,
    confidence: 0.92,
    alternatives: [],
    extractedText: [],
    barcodes: [],
  },
  clearingRecommendation: "sell",
  status: "ready",
  media: [
    {
      id: "media-1",
      itemId: "item-1",
      storagePath: "household-1/item-1/main.jpg",
      contentSha256: "a".repeat(64),
      mediaType: "image/jpeg",
      order: 0,
      isLead: true,
      qualityIssues: [],
      redactionState: "not_needed",
      source: "camera",
      exifLocationStripped: true,
      retentionState: "permanent",
      createdAt,
    },
  ],
  createdAt,
  updatedAt: createdAt,
} satisfies Item;

const listing = {
  id: "listing-1",
  itemId: item.id,
  version: 1,
  title: "Solid oak side table in good condition",
  description: "A sturdy table for a living room or bedroom.",
  conditionSummary: "Good used condition with one small scratch.",
  specifications: {},
  priceStrategy: "balanced",
  askingPrice: { amountCents: 4_500, currency: "USD" },
  minimumPrice: { amountCents: 3_500, currency: "USD" },
  location: { zipCode: "94107", displayArea: "Mission Bay", radiusMiles: 10 },
  exchangeOptions: ["public_meetup"],
  paymentWording: "cash_preferred",
  negotiationRules: household.priceRules,
  restrictedItemStatus: "clear",
  restrictedItemReasons: [],
  approvedAt: createdAt,
  createdAt,
} satisfies CanonicalListing;

describe("platform listing variants", () => {
  it("maps category and field names without exposing an exact location", () => {
    const connector = ConnectorManifestSchema.parse({
      id: "test",
      platform: "Test Local",
      kind: "api",
      version: "1.0.0",
      definitionVersion: 1,
      enabled: true,
      killSwitchReason: null,
      policyStatus: "internal_only",
      productionMethod: null,
      approvalEvidenceUrl: null,
      policyReviewedAt: createdAt,
      owner: "engineering",
      capabilities: {
        publish: true,
        edit: true,
        delist: true,
        mark_sold: true,
        message_read: false,
        message_send: false,
        import: false,
      },
      supportedAppVersions: [],
      requiredFields: ["title", "description", "price", "photos"],
      categoryMappings: { furniture: "home/tables" },
      fieldMappings: { price: "asking_price" },
      titleMaxLength: 32,
      descriptionMaxLength: 500,
      rateLimitPerMinute: 5,
      dailyListingCap: 100,
      canaryTestId: "canary",
      changeLog: [
        {
          version: "1",
          changedAt: createdAt,
          changedBy: "test",
          summary: "test",
        },
      ],
    });
    const variant = createPlatformListingVariant({
      id: "variant-1",
      item,
      listing,
      household,
      connector,
      generatedAt: createdAt,
    });
    expect(variant.category).toBe("home/tables");
    expect(variant.title.length).toBeLessThanOrEqual(32);
    expect(variant.fields.asking_price).toEqual(listing.askingPrice);
    expect(JSON.stringify(variant.fields)).not.toContain("94107");
    expect(JSON.stringify(variant.fields)).toContain("941");
  });
});
