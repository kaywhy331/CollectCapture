import { z } from "zod";
import {
  ConfidenceSchema,
  MoneySchema,
  PriceRecommendationSchema,
  type PriceRecommendation,
} from "./schemas.js";

export const ComparableSchema = z
  .object({
    id: z.string().trim().min(1),
    amount: MoneySchema,
    outcomeType: z.enum(["verified_sold", "active_asking"]),
    sourceName: z.string().trim().min(1).max(160),
    sourceApproval: z.literal("approved"),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type Comparable = z.infer<typeof ComparableSchema>;

export const PricingFactorsSchema = z
  .object({
    conditionMultiplier: z.number().min(0.1).max(2).default(1),
    localDemandMultiplier: z.number().min(0.5).max(1.5).default(1),
    seasonalityMultiplier: z.number().min(0.5).max(1.5).default(1),
  })
  .strict();
export type PricingFactors = z.infer<typeof PricingFactorsSchema>;

const PRICE_DISCLAIMER =
  "This is an estimate based on approved comparable data, not a guaranteed sale price.";

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate a median without values");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const center = sorted[middle];
  if (center === undefined) {
    throw new Error("Cannot calculate comparable median");
  }
  if (sorted.length % 2 === 1) {
    return center;
  }
  const left = sorted[middle - 1];
  if (left === undefined) {
    throw new Error("Cannot calculate comparable median");
  }
  return (left + center) / 2;
}

function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) return 1;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (average === 0) return 1;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    values.length;
  return Math.sqrt(variance) / average;
}

function roundToDollar(cents: number): number {
  return Math.max(100, Math.round(cents / 100) * 100);
}

export function generatePriceRecommendations(input: {
  comparables: readonly Comparable[];
  factors: PricingFactors;
}): PriceRecommendation[] {
  const comparables = input.comparables.map((comparable) =>
    ComparableSchema.parse(comparable),
  );
  if (comparables.length === 0) {
    throw new Error("At least one approved comparable is required");
  }
  const currencies = new Set(
    comparables.map((comparable) => comparable.amount.currency),
  );
  if (currencies.size !== 1) {
    throw new Error("Comparable currencies must match");
  }

  const sold = comparables.filter(
    (comparable) => comparable.outcomeType === "verified_sold",
  );
  const asking = comparables.filter(
    (comparable) => comparable.outcomeType === "active_asking",
  );
  const basis = sold.length > 0 ? sold : asking;
  const basisAmounts = basis.map((comparable) => comparable.amount.amountCents);
  const askingDiscount = sold.length > 0 ? 1 : 0.9;
  const factorMultiplier =
    input.factors.conditionMultiplier *
    input.factors.localDemandMultiplier *
    input.factors.seasonalityMultiplier;
  const balanced = median(basisAmounts) * askingDiscount * factorMultiplier;

  const countScore = Math.min(1, comparables.length / 12);
  const soldScore = Math.min(1, sold.length / 6);
  const dispersionScore = Math.max(0, 1 - coefficientOfVariation(basisAmounts));
  const confidence = ConfidenceSchema.parse(
    Math.round(
      (countScore * 0.35 + soldScore * 0.4 + dispersionScore * 0.25) * 100,
    ) / 100,
  );
  const adjustmentFactors = [
    `Condition adjustment: ${input.factors.conditionMultiplier.toFixed(2)}x`,
    `Local demand adjustment: ${input.factors.localDemandMultiplier.toFixed(2)}x`,
    `Seasonality adjustment: ${input.factors.seasonalityMultiplier.toFixed(2)}x`,
    sold.length > 0
      ? "Primary basis: verified sold outcomes"
      : "Primary basis: active asking prices discounted by 10%",
  ];
  const common = {
    confidence,
    comparableCount: comparables.length,
    soldComparableCount: sold.length,
    askingComparableCount: asking.length,
    adjustmentFactors,
    disclaimer: PRICE_DISCLAIMER,
  };
  const currency = comparables[0]?.amount.currency;
  if (!currency) {
    throw new Error("Comparable currency is required");
  }

  return [
    PriceRecommendationSchema.parse({
      ...common,
      strategy: "sell_fast",
      price: { amountCents: roundToDollar(balanced * 0.85), currency },
    }),
    PriceRecommendationSchema.parse({
      ...common,
      strategy: "balanced",
      price: { amountCents: roundToDollar(balanced), currency },
    }),
    PriceRecommendationSchema.parse({
      ...common,
      strategy: "maximize_value",
      price: { amountCents: roundToDollar(balanced * 1.15), currency },
    }),
  ];
}

export function overrideRecommendedPrice(input: {
  recommendation: PriceRecommendation;
  amountCents: number;
  minimumPriceCents: number;
}): PriceRecommendation {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
    throw new Error(
      "Override price must be a non-negative integer number of cents",
    );
  }
  if (input.amountCents < input.minimumPriceCents) {
    throw new Error(
      "Override price cannot be below the configured minimum price",
    );
  }
  return PriceRecommendationSchema.parse({
    ...input.recommendation,
    price: {
      ...input.recommendation.price,
      amountCents: input.amountCents,
    },
    adjustmentFactors: [
      ...input.recommendation.adjustmentFactors,
      "User-overridden price",
    ],
  });
}
