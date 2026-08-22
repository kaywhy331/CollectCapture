import { CardRecognitionSchema } from "@localclear/domain";
import { describe, expect, it } from "vitest";
import { compareRecognition } from "../src/card-recognition-qualification.js";

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
