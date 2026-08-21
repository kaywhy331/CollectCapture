import { describe, expect, it } from "vitest";
import { suggestRelatedItemBundles, type Item } from "../src/index.js";

const base: Item = {
  id: "item-1",
  householdId: "household-1",
  title: "Oak side table",
  category: "Furniture",
  brand: null,
  model: null,
  condition: "good",
  dimensions: {},
  specifications: {},
  accessories: [],
  defects: [],
  storageLocation: "garage shelf A",
  identification: {
    itemType: "Side table",
    category: "Furniture",
    brand: null,
    model: null,
    confidence: 0.9,
    alternatives: [],
    extractedText: [],
    barcodes: [],
  },
  clearingRecommendation: "bundle",
  status: "captured",
  media: [
    {
      id: "media-1",
      itemId: "item-1",
      storagePath: "household-1/one.jpg",
      contentSha256: "a".repeat(64),
      mediaType: "image/jpeg",
      order: 0,
      isLead: true,
      qualityIssues: [],
      redactionState: "not_needed",
      source: "camera",
      exifLocationStripped: true,
      retentionState: "permanent",
      createdAt: "2026-08-20T00:00:00.000Z",
    },
  ],
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

describe("bundle suggestions", () => {
  it("groups related active items and ignores cleared inventory", () => {
    const related: Item = {
      ...base,
      id: "item-2",
      title: "Oak coffee table",
      media: [{ ...base.media[0]!, id: "media-2", itemId: "item-2" }],
    };
    const sold: Item = {
      ...related,
      id: "item-3",
      status: "sold",
      media: [{ ...base.media[0]!, id: "media-3", itemId: "item-3" }],
    };
    const suggestions = suggestRelatedItemBundles({
      targetItemId: base.id,
      items: [base, related, sold],
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.itemIds).toEqual(["item-1", "item-2"]);
    expect(suggestions[0]?.rationale).toContain("same category");
  });
});
