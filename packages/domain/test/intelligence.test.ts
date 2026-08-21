import { describe, expect, it } from "vitest";
import {
  ItemEnrichmentOutputSchema,
  assertEnrichmentEvidenceBelongsToItem,
  restrictedScreenFromSignals,
  type ItemEnrichmentOutput,
} from "../src/index.js";

function output(mediaAssetId = "media-1"): ItemEnrichmentOutput {
  const evidence = [{ mediaAssetId, observation: "Visible item surface" }];
  return ItemEnrichmentOutputSchema.parse({
    identification: {
      itemType: "Side table",
      category: "Furniture",
      brand: null,
      model: null,
      confidence: 0.75,
      alternatives: [],
      extractedText: [],
      barcodes: [],
    },
    title: {
      value: "Wood side table",
      confidence: 0.75,
      provenance: "image_derived",
      evidence,
    },
    category: {
      value: "Furniture",
      confidence: 0.8,
      provenance: "image_derived",
      evidence,
    },
    brand: {
      value: null,
      confidence: 0,
      provenance: "inferred",
      evidence: [],
    },
    model: {
      value: null,
      confidence: 0,
      provenance: "inferred",
      evidence: [],
    },
    condition: { value: "good", confidence: 0.7, evidence },
    dimensions: [],
    specifications: [],
    accessories: [],
    defects: [],
    mediaAssessments: [
      {
        mediaAssetId,
        qualityIssues: [],
        redactionSuggested: false,
        redactionReasons: [],
        leadPhotoScore: 0.8,
        leadPhotoReasons: ["Complete item view"],
      },
    ],
    suggestedAdditionalPhotos: [],
    listingDraft: {
      title: "Wood side table",
      description: "A wood side table in good used condition.",
      conditionSummary: "Good used condition.",
    },
    clearingRecommendation: {
      value: "sell",
      confidence: 0.7,
      rationale: "Appears usable and suitable for local sale.",
    },
    restrictedSignals: [],
    unresolvedQuestions: [],
  });
}

describe("item intelligence contracts", () => {
  it("limits the review to three high-value unresolved questions", () => {
    expect(
      ItemEnrichmentOutputSchema.safeParse({
        ...output(),
        unresolvedQuestions: ["one", "two", "three"],
      }).success,
    ).toBe(true);
    expect(
      ItemEnrichmentOutputSchema.safeParse({
        ...output(),
        unresolvedQuestions: ["one", "two", "three", "four"],
      }).success,
    ).toBe(false);
  });

  it("rejects evidence and media assessments from another item", () => {
    expect(() =>
      assertEnrichmentEvidenceBelongsToItem(
        output("media-from-another-item"),
        new Set(["media-1"]),
      ),
    ).toThrow(/outside the item/);
  });

  it("turns safety signals into conservative review and block states", () => {
    expect(restrictedScreenFromSignals([])).toEqual({
      status: "clear",
      reasons: [],
    });
    expect(
      restrictedScreenFromSignals([
        {
          label: "Possible recall",
          rationale: "A matching label needs manual verification",
          severity: "review",
          confidence: 0.6,
          evidence: [],
        },
      ]).status,
    ).toBe("review");
    expect(
      restrictedScreenFromSignals([
        {
          label: "Weapon",
          rationale: "The photo may show a prohibited weapon",
          severity: "block",
          confidence: 0.9,
          evidence: [],
        },
      ]).status,
    ).toBe("blocked");
  });
});
