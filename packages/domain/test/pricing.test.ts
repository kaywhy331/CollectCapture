import { describe, expect, it } from "vitest";
import {
  ComparableSchema,
  generatePriceRecommendations,
  overrideRecommendedPrice,
} from "../src/index.js";

const factors = {
  conditionMultiplier: 0.9,
  localDemandMultiplier: 1.1,
  seasonalityMultiplier: 1,
};

describe("price recommendations", () => {
  it("separates verified outcomes from active asking prices", () => {
    const recommendations = generatePriceRecommendations({
      comparables: [
        {
          id: "sold-1",
          amount: { amountCents: 10_000, currency: "USD" },
          outcomeType: "verified_sold",
          sourceName: "Approved outcomes",
          sourceApproval: "approved",
          observedAt: "2026-08-19T12:00:00.000Z",
        },
        {
          id: "sold-2",
          amount: { amountCents: 12_000, currency: "USD" },
          outcomeType: "verified_sold",
          sourceName: "Approved outcomes",
          sourceApproval: "approved",
          observedAt: "2026-08-18T12:00:00.000Z",
        },
        {
          id: "ask-1",
          amount: { amountCents: 20_000, currency: "USD" },
          outcomeType: "active_asking",
          sourceName: "Approved listings",
          sourceApproval: "approved",
          observedAt: "2026-08-20T12:00:00.000Z",
        },
      ],
      factors,
    });

    expect(recommendations.map((value) => value.strategy)).toEqual([
      "sell_fast",
      "balanced",
      "maximize_value",
    ]);
    expect(recommendations[0]?.price.amountCents).toBeLessThan(
      recommendations[1]?.price.amountCents ?? 0,
    );
    expect(recommendations[2]?.price.amountCents).toBeGreaterThan(
      recommendations[1]?.price.amountCents ?? Number.POSITIVE_INFINITY,
    );
    expect(recommendations[1]).toMatchObject({
      soldComparableCount: 2,
      askingComparableCount: 1,
      comparableCount: 3,
    });
    expect(recommendations[1]?.disclaimer).toContain(
      "not a guaranteed sale price",
    );
  });

  it("rejects unapproved comparable payloads at the boundary", () => {
    expect(() =>
      ComparableSchema.parse({
        id: "bad-source",
        amount: { amountCents: 10_000, currency: "USD" },
        outcomeType: "verified_sold",
        sourceName: "Unknown scraper",
        sourceApproval: "unapproved",
        observedAt: "2026-08-20T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("allows a user override while enforcing the item price floor", () => {
    const [recommendation] = generatePriceRecommendations({
      comparables: [
        {
          id: "sold-1",
          amount: { amountCents: 10_000, currency: "USD" },
          outcomeType: "verified_sold",
          sourceName: "Approved outcomes",
          sourceApproval: "approved",
          observedAt: "2026-08-19T12:00:00.000Z",
        },
      ],
      factors,
    });
    expect(recommendation).toBeDefined();
    if (!recommendation) return;

    expect(
      overrideRecommendedPrice({
        recommendation,
        amountCents: 9_500,
        minimumPriceCents: 8_000,
      }).adjustmentFactors,
    ).toContain("User-overridden price");
    expect(() =>
      overrideRecommendedPrice({
        recommendation,
        amountCents: 7_500,
        minimumPriceCents: 8_000,
      }),
    ).toThrow("below the configured minimum price");
  });
});
