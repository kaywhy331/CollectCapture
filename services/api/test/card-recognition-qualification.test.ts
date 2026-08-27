import {
  CardLookupCandidateSchema,
  CardRecognitionSchema,
} from "@localclear/domain";
import { describe, expect, it } from "vitest";
import {
  catalogMatchCheck,
  compareRecognition,
  evaluateQualification,
  matchesExpectedCatalog,
  summarizeLatency,
  type CaseOutcome,
  type FieldCheck,
} from "../src/card-recognition-qualification.js";

describe("card recognition qualification scoring", () => {
  it("normalizes visible identity fields while preserving null checks", () => {
    const recognition = CardRecognitionSchema.parse({
      source: "vision",
      category: "pokemon",
      name: "Charizard ex",
      setName: null,
      collectorNumber: "023/197",
      language: "en",
      visibleText: ["Charizard ex", "23 / 197"],
      queries: ["Charizard ex 23/197"],
      confidence: 0.9,
      provider: "test",
      model: "test-vision",
    });

    expect(
      compareRecognition(recognition, {
        category: "pokemon",
        name: "CHARIZARD-EX",
        setName: null,
        collectorNumber: "23/197",
        visibleText: ["charizard ex", "23 197"],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "name", passed: true }),
        expect.objectContaining({ field: "setName", passed: true }),
        expect.objectContaining({ field: "collectorNumber", passed: true }),
        expect.objectContaining({ field: "visibleText", passed: true }),
      ]),
    );
  });
});

function candidate(overrides: Partial<Record<string, unknown>> = {}) {
  return CardLookupCandidateSchema.parse({
    id: "tcgcsv:3:123:456",
    externalId: "3:123:456",
    provider: "tcgcsv",
    category: "tcgcsv-category-3",
    game: "Pokemon",
    name: "Charizard ex",
    setName: "Obsidian Flames",
    setCode: "OBF",
    number: "223/197",
    variant: "",
    rarity: "",
    year: "2023",
    image: "",
    imageSmall: "",
    price: null,
    priceOptions: [],
    currency: "USD",
    priceSource: "",
    priceUrl: "",
    priceUpdatedAt: "",
    matchBucket: "likely",
    matchScore: 0.9,
    categoryId: 3,
    groupId: 123,
    productId: 456,
    ...overrides,
  });
}

describe("matchesExpectedCatalog (G3b)", () => {
  it("matches decisively on productId alone, ignoring other fields", () => {
    expect(
      matchesExpectedCatalog(candidate({ name: "A totally different name" }), {
        productId: 456,
        topN: 5,
      }),
    ).toBe(true);
    expect(
      matchesExpectedCatalog(candidate(), { productId: 999, topN: 5 }),
    ).toBe(false);
  });

  it("matches on name (case/whitespace-insensitive) when no productId is given", () => {
    expect(
      matchesExpectedCatalog(candidate(), {
        name: "  charizard EX  ",
        topN: 5,
      }),
    ).toBe(true);
    expect(
      matchesExpectedCatalog(candidate(), { name: "Blastoise ex", topN: 5 }),
    ).toBe(false);
  });

  it("requires every declared field (name, setName, collectorNumber) to match", () => {
    expect(
      matchesExpectedCatalog(candidate(), {
        name: "Charizard ex",
        setName: "Obsidian Flames",
        collectorNumber: "223/197",
        topN: 5,
      }),
    ).toBe(true);
    expect(
      matchesExpectedCatalog(candidate(), {
        name: "Charizard ex",
        setName: "A different set",
        topN: 5,
      }),
    ).toBe(false);
  });
});

describe("catalogMatchCheck against a mocked catalog (G3b)", () => {
  it("passes when the expected product is among the (mocked) top-N results", () => {
    const mockedCatalogResults = [
      candidate({ productId: 111, name: "Blastoise ex" }),
      candidate({ productId: 456, name: "Charizard ex" }),
      candidate({ productId: 789, name: "Venusaur ex" }),
    ];

    const check = catalogMatchCheck(mockedCatalogResults, {
      productId: 456,
      topN: 5,
    });
    expect(check).toMatchObject({ field: "catalogMatch", passed: true });
  });

  it("fails when the expected product never appears in the (mocked) results", () => {
    const mockedCatalogResults = [
      candidate({ productId: 111, name: "Blastoise ex" }),
      candidate({ productId: 789, name: "Venusaur ex" }),
    ];

    const check = catalogMatchCheck(mockedCatalogResults, {
      productId: 456,
      name: "Charizard ex",
      topN: 5,
    });
    expect(check).toMatchObject({ field: "catalogMatch", passed: false });
    expect(check.actual).toContain("Blastoise ex");
    expect(check.actual).toContain("Venusaur ex");
  });

  it("fails on an empty (mocked) result set", () => {
    const check = catalogMatchCheck([], { name: "Charizard ex", topN: 5 });
    expect(check).toMatchObject({
      field: "catalogMatch",
      passed: false,
      actual: "0 candidate(s): <none>",
    });
  });
});

function passedCheck(field: string): FieldCheck {
  return { field, passed: true, expected: "x", actual: "x" };
}

function failedCheck(field: string): FieldCheck {
  return { field, passed: false, expected: "x", actual: "y" };
}

describe("evaluateQualification (G3c)", () => {
  it("gates on the overall pass rate when every category clears the threshold", () => {
    const outcomes: CaseOutcome[] = [
      {
        id: "a",
        category: "pokemon",
        language: "en",
        checks: [passedCheck("name")],
      },
      {
        id: "b",
        category: "magic",
        language: "en",
        checks: [passedCheck("name")],
      },
    ];
    const evaluation = evaluateQualification(outcomes, 0.9);
    expect(evaluation.qualified).toBe(true);
    expect(evaluation.failingCategories).toEqual([]);
  });

  it("fails a category whose own rate is below threshold even though the overall blended rate clears it", () => {
    // 9 pokemon cases all pass; 1 magic case fails entirely. Overall:
    // 9/10 = 90% clears a 90% threshold, but magic's own rate (0/1 = 0%)
    // does not -- the per-category gate must still fail the run.
    const outcomes: CaseOutcome[] = [
      ...Array.from({ length: 9 }, (_unused, index) => ({
        id: `pokemon-${index}`,
        category: "pokemon" as const,
        language: "en",
        checks: [passedCheck("name")],
      })),
      {
        id: "magic-fail",
        category: "magic",
        language: "en",
        checks: [failedCheck("name")],
      },
    ];
    const evaluation = evaluateQualification(outcomes, 0.9);
    expect(evaluation.passRate).toBeCloseTo(0.9);
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.failingCategories).toEqual(["magic"]);
  });

  it("reports a per-language breakdown without gating on it", () => {
    // 9 English pokemon cases pass and 1 Japanese pokemon case fails: the
    // pokemon category's own rate (9/10 = 90%) still clears the 90%
    // threshold, so the language-level failure must show up in the
    // report without failing the (category-only) gate.
    const outcomes: CaseOutcome[] = [
      ...Array.from({ length: 9 }, (_unused, index) => ({
        id: `pokemon-en-${index}`,
        category: "pokemon" as const,
        language: "en",
        checks: [passedCheck("name")],
      })),
      {
        id: "pokemon-ja-fail",
        category: "pokemon",
        language: "ja",
        checks: [failedCheck("name")],
      },
    ];
    const evaluation = evaluateQualification(outcomes, 0.9);
    expect(evaluation.languageAggregates.get("ja")).toMatchObject({
      passedChecks: 0,
      totalChecks: 1,
    });
    expect(evaluation.languageAggregates.get("en")).toMatchObject({
      passedChecks: 9,
      totalChecks: 9,
    });
    expect(evaluation.qualified).toBe(true);
    expect(evaluation.failingCategories).toEqual([]);
  });
});

describe("summarizeLatency (G3d)", () => {
  it("excludes the first (warm-up) sample from the average and p95", () => {
    // A 5000 ms warm-up outlier would otherwise dominate the average.
    const summary = summarizeLatency([5_000, 100, 120, 110]);
    expect(summary.sampledDurationsMs).toEqual([100, 120, 110]);
    expect(summary.averageMs).toBeCloseTo((100 + 120 + 110) / 3);
  });

  it("returns zeroed stats when only the warm-up sample exists", () => {
    const summary = summarizeLatency([5_000]);
    expect(summary.sampledDurationsMs).toEqual([]);
    expect(summary.averageMs).toBe(0);
    expect(summary.p95Ms).toBe(0);
  });
});
