import { describe, expect, it } from "vitest";
import {
  InvalidItemTransitionError,
  deriveItemStatus,
  findLikelyDuplicates,
  planInventoryClosure,
  transitionItemStatus,
} from "../src/index.js";

describe("inventory lifecycle", () => {
  it("supports the user-visible lifecycle and rejects invalid reopening", () => {
    expect(transitionItemStatus("captured", "draft")).toBe("draft");
    expect(transitionItemStatus("live", "reserved")).toBe("reserved");
    expect(transitionItemStatus("reserved", "sold")).toBe("sold");
    expect(transitionItemStatus("captured", "donated")).toBe("donated");
    expect(() => transitionItemStatus("sold", "live")).toThrow(
      InvalidItemTransitionError,
    );
  });

  it("derives partial and fully live status independently of platform count", () => {
    expect(
      deriveItemStatus(
        [{ status: "live" }, { status: "publishing" }],
        "publishing",
      ),
    ).toBe("partially_live");
    expect(
      deriveItemStatus([{ status: "live" }, { status: "live" }], "publishing"),
    ).toBe("live");
  });

  it("plans one closure action and one consolidated exception task", () => {
    const plan = planInventoryClosure(
      [
        {
          platformListingId: "listing-1",
          platform: "API Market",
          status: "live",
          capabilities: ["mark_sold", "delist"],
          connectorAllowed: true,
        },
        {
          platformListingId: "listing-2",
          platform: "Manual Market",
          status: "live",
          capabilities: [],
          connectorAllowed: true,
        },
        {
          platformListingId: "listing-3",
          platform: "Disabled Market",
          status: "live",
          capabilities: ["delist"],
          connectorAllowed: false,
        },
      ],
      "sold",
    );

    expect(plan.operations).toEqual([
      {
        platformListingId: "listing-1",
        platform: "API Market",
        action: "mark_sold",
      },
    ]);
    expect(plan.exceptionTask?.exceptions).toHaveLength(2);
  });
});

describe("duplicate detection", () => {
  it("flags matching barcodes, image fingerprints, or strong model evidence", () => {
    const matches = findLikelyDuplicates(
      {
        id: "new",
        normalizedTitle: "makita cordless drill",
        barcode: "012345678905",
        imageFingerprint: null,
        brand: "Makita",
        model: "XFD10",
      },
      [
        {
          id: "existing",
          normalizedTitle: "makita cordless drill",
          barcode: "012345678905",
          imageFingerprint: null,
          brand: "Makita",
          model: "XFD10",
        },
        {
          id: "different",
          normalizedTitle: "wood chair",
          barcode: null,
          imageFingerprint: null,
          brand: null,
          model: null,
        },
      ],
    );
    expect(matches).toEqual([
      {
        itemId: "existing",
        score: 1,
        reasons: [
          "matching barcode",
          "matching brand and model",
          "matching title",
        ],
      },
    ]);
  });
});
