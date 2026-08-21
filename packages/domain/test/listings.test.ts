import { describe, expect, it } from "vitest";
import {
  assertSpecificationsPublishable,
  classifySpecificationsForPublishing,
  type SpecificationValue,
} from "../src/index.js";

describe("specification publication provenance", () => {
  const specifications: Record<string, SpecificationValue> = {
    color: {
      value: "blue",
      provenance: "image_derived",
      confidence: 0.97,
    },
    modelYear: {
      value: "2024",
      provenance: "catalog_derived",
      confidence: 0.7,
    },
    material: {
      value: "oak",
      provenance: "inferred",
      confidence: 0.99,
    },
    width: {
      value: "24 inches",
      provenance: "user_confirmed",
      confidence: 1,
    },
  };

  it("publishes verified evidence and user-confirmed values only", () => {
    const result = classifySpecificationsForPublishing(specifications, 0.85);
    expect(Object.keys(result.publishable)).toEqual(["color", "width"]);
    expect(result.blocked).toEqual([
      {
        key: "modelYear",
        reason: "below_confidence_threshold",
        confidence: 0.7,
      },
      { key: "material", reason: "inferred", confidence: 0.99 },
    ]);
  });

  it("blocks publication until unresolved specifications are removed or confirmed", () => {
    expect(() => assertSpecificationsPublishable(specifications)).toThrow(
      "unverified specifications: modelYear, material",
    );
  });
});
