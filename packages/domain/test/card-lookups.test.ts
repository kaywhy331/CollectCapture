import { describe, expect, it } from "vitest";
import {
  CardLookupCandidateSchema,
  CardLookupRequestSchema,
  CardLookupResultSchema,
} from "../src/card-lookups.js";

describe("card lookup contracts", () => {
  it("accepts a bounded sanitized card image request", () => {
    expect(
      CardLookupRequestSchema.parse({
        imageDataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      }),
    ).toMatchObject({ category: "all", limit: 12, query: "" });
  });

  it("rejects remote image URLs and unsupported image media", () => {
    expect(() =>
      CardLookupRequestSchema.parse({
        imageDataUrl: "https://images.example.test/card.jpg",
      }),
    ).toThrow();
    expect(() =>
      CardLookupRequestSchema.parse({
        imageDataUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==",
      }),
    ).toThrow();
  });

  it("requires lookup results to disclose non-retention", () => {
    expect(() =>
      CardLookupResultSchema.parse({
        contentSha256: "a".repeat(64),
        imageRetained: true,
        recognition: {},
        candidates: [],
        warnings: [],
      }),
    ).toThrow();
  });

  it("labels catalog rows as suggestions until the collector confirms one", () => {
    expect(
      CardLookupCandidateSchema.shape.matchBucket.safeParse("likely").success,
    ).toBe(true);
    expect(
      CardLookupCandidateSchema.shape.matchBucket.safeParse("exact").success,
    ).toBe(false);
  });
});
