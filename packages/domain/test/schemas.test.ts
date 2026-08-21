import { describe, expect, it } from "vitest";
import {
  CanonicalListingSchema,
  ItemSchema,
  PlatformConnectionSchema,
  SellerDeviceSchema,
} from "../src/index.js";

const now = "2026-08-20T12:00:00.000Z";

function media(index: number) {
  return {
    id: `media-${index}`,
    itemId: "item-1",
    storagePath: `household/item-${index}.jpg`,
    contentSha256: "a".repeat(64),
    mediaType: "image/jpeg" as const,
    order: index,
    isLead: index === 0,
    qualityIssues: [],
    redactionState: "not_needed" as const,
    source: "camera" as const,
    exifLocationStripped: true,
    retentionState: "permanent" as const,
    createdAt: now,
  };
}

function itemWithMedia(count: number) {
  return {
    id: "item-1",
    householdId: "household-1",
    title: "Solid oak side table",
    category: "Furniture",
    brand: null,
    model: null,
    condition: "good",
    dimensions: {},
    specifications: {},
    accessories: [],
    defects: ["Small scratch on top"],
    storageLocation: "garage shelf A",
    identification: {
      itemType: "Side table",
      category: "Furniture",
      brand: null,
      model: null,
      confidence: 0.91,
      alternatives: [],
      extractedText: [],
      barcodes: [],
    },
    clearingRecommendation: "sell",
    status: "draft",
    media: Array.from({ length: count }, (_, index) => media(index)),
    createdAt: now,
    updatedAt: now,
  };
}

describe("core data contracts", () => {
  it("accepts 1–12 photos per item and rejects counts outside that boundary", () => {
    expect(ItemSchema.safeParse(itemWithMedia(1)).success).toBe(true);
    expect(ItemSchema.safeParse(itemWithMedia(12)).success).toBe(true);
    expect(ItemSchema.safeParse(itemWithMedia(0)).success).toBe(false);
    expect(ItemSchema.safeParse(itemWithMedia(13)).success).toBe(false);
  });

  it("requires Android 11 or newer for Seller Hub devices", () => {
    const device = {
      id: "device-1",
      householdId: "household-1",
      displayName: "Spare phone",
      publicKey: "a".repeat(64),
      androidVersion: 10,
      appVersion: "1.0.0",
      isPrimary: true,
      connectionStatus: "pairing",
      batteryPercent: 90,
      isCharging: true,
      networkType: "wifi",
      lastCheckInAt: now,
      capabilities: [],
      revokedAt: null,
    };
    expect(SellerDeviceSchema.safeParse(device).success).toBe(false);
    expect(
      SellerDeviceSchema.safeParse({ ...device, androidVersion: 11 }).success,
    ).toBe(true);
  });

  it("has no credential fields and rejects accidental password storage", () => {
    const connection = {
      id: "connection-1",
      sellerDeviceId: "device-1",
      platform: "Test Market",
      appVersion: "10.4.0",
      displayAlias: "My account",
      connectionStatus: "connected",
      lastVerifiedAt: now,
      supportedCapabilities: ["publish"],
      policyStatus: "approved",
    };
    expect(PlatformConnectionSchema.safeParse(connection).success).toBe(true);
    expect(
      PlatformConnectionSchema.safeParse({ ...connection, password: "secret" })
        .success,
    ).toBe(false);
  });

  it("prevents a listing minimum price from exceeding its asking price", () => {
    const listing = {
      id: "listing-1",
      itemId: "item-1",
      version: 1,
      title: "Solid oak side table",
      description: "Solid table with a small scratch shown in photos.",
      conditionSummary: "Good used condition",
      specifications: {},
      priceStrategy: "balanced",
      askingPrice: { amountCents: 5_000, currency: "USD" },
      minimumPrice: { amountCents: 6_000, currency: "USD" },
      location: {
        zipCode: "94107",
        displayArea: "Potrero Hill",
        radiusMiles: 15,
      },
      exchangeOptions: ["public_meetup"],
      paymentWording: "cash_preferred",
      negotiationRules: {
        defaultMinimumOfferPercent: 70,
        defaultHoldMinutes: 120,
        acceptsTrades: false,
      },
      restrictedItemStatus: "clear",
      restrictedItemReasons: [],
      approvedAt: null,
      createdAt: now,
    };
    expect(CanonicalListingSchema.safeParse(listing).success).toBe(false);
    expect(
      CanonicalListingSchema.safeParse({
        ...listing,
        minimumPrice: { amountCents: 4_000, currency: "USD" },
      }).success,
    ).toBe(true);
  });
});
