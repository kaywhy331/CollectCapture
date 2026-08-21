import { z } from "zod";
import {
  ClearingRecommendationSchema,
  ConfidenceSchema,
  EntityIdSchema,
  IdentificationSchema,
  MediaQualityIssueSchema,
  TimestampSchema,
} from "./schemas.js";

export const VisualEvidenceSchema = z
  .object({
    mediaAssetId: EntityIdSchema,
    observation: z.string().trim().min(1).max(500),
  })
  .strict();
export type VisualEvidence = z.infer<typeof VisualEvidenceSchema>;

export const SuggestedTextFactSchema = z
  .object({
    value: z.string().trim().min(1).max(500),
    confidence: ConfidenceSchema,
    provenance: z.enum(["image_derived", "inferred"]),
    evidence: z.array(VisualEvidenceSchema).max(12),
  })
  .strict();
export type SuggestedTextFact = z.infer<typeof SuggestedTextFactSchema>;

export const SuggestedNullableTextFactSchema = z
  .object({
    value: z.string().trim().min(1).max(500).nullable(),
    confidence: ConfidenceSchema,
    provenance: z.enum(["image_derived", "inferred"]),
    evidence: z.array(VisualEvidenceSchema).max(12),
  })
  .strict();

export const SuggestedSpecificationSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    value: z.string().trim().min(1).max(500),
    confidence: ConfidenceSchema,
    provenance: z.enum(["image_derived", "inferred"]),
    evidence: z.array(VisualEvidenceSchema).max(12),
  })
  .strict();
export type SuggestedSpecification = z.infer<
  typeof SuggestedSpecificationSchema
>;

// Keep physical condition distinct from the inventory lifecycle state and
// closed so structured output cannot invent new values.
export const SuggestedConditionSchema = z
  .object({
    value: z.enum([
      "new",
      "like_new",
      "good",
      "fair",
      "poor",
      "for_parts",
      "unknown",
    ]),
    confidence: ConfidenceSchema,
    evidence: z.array(VisualEvidenceSchema).max(12),
  })
  .strict();

export const MediaAssessmentSchema = z
  .object({
    mediaAssetId: EntityIdSchema,
    qualityIssues: z.array(MediaQualityIssueSchema),
    redactionSuggested: z.boolean(),
    redactionReasons: z.array(z.string().trim().min(1).max(500)).max(20),
    leadPhotoScore: ConfidenceSchema,
    leadPhotoReasons: z.array(z.string().trim().min(1).max(240)).max(5),
  })
  .strict();

export const SuggestedAdditionalPhotoSchema = z
  .object({
    kind: z.enum(["label", "model_number", "damage", "scale", "accessories"]),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

export const RestrictedSignalSchema = z
  .object({
    label: z.string().trim().min(1).max(240),
    rationale: z.string().trim().min(1).max(1_000),
    severity: z.enum(["review", "block"]),
    confidence: ConfidenceSchema,
    evidence: z.array(VisualEvidenceSchema).max(12),
  })
  .strict();

export const ItemEnrichmentOutputSchema = z
  .object({
    identification: IdentificationSchema,
    title: SuggestedTextFactSchema,
    category: SuggestedTextFactSchema,
    brand: SuggestedNullableTextFactSchema,
    model: SuggestedNullableTextFactSchema,
    condition: SuggestedConditionSchema,
    dimensions: z.array(SuggestedSpecificationSchema).max(20),
    specifications: z.array(SuggestedSpecificationSchema).max(50),
    accessories: z.array(SuggestedTextFactSchema).max(50),
    defects: z.array(SuggestedTextFactSchema).max(50),
    mediaAssessments: z.array(MediaAssessmentSchema).max(12),
    suggestedAdditionalPhotos: z.array(SuggestedAdditionalPhotoSchema).max(5),
    listingDraft: z
      .object({
        title: z.string().trim().min(1).max(240),
        description: z.string().trim().min(1).max(10_000),
        conditionSummary: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    clearingRecommendation: z
      .object({
        value: ClearingRecommendationSchema,
        confidence: ConfidenceSchema,
        rationale: z.string().trim().min(1).max(1_000),
      })
      .strict(),
    restrictedSignals: z.array(RestrictedSignalSchema).max(20),
    unresolvedQuestions: z.array(z.string().trim().min(1).max(500)).max(3),
  })
  .strict();
export type ItemEnrichmentOutput = z.infer<typeof ItemEnrichmentOutputSchema>;

export const ItemEnrichmentSchema = z
  .object({
    id: EntityIdSchema,
    householdId: EntityIdSchema,
    itemId: EntityIdSchema,
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(160),
    output: ItemEnrichmentOutputSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type ItemEnrichment = z.infer<typeof ItemEnrichmentSchema>;

export function restrictedScreenFromSignals(
  signals: readonly z.infer<typeof RestrictedSignalSchema>[],
): { status: "clear" | "review" | "blocked"; reasons: string[] } {
  const validated = signals.map((signal) =>
    RestrictedSignalSchema.parse(signal),
  );
  if (validated.some((signal) => signal.severity === "block")) {
    return {
      status: "blocked",
      reasons: validated.map(
        (signal) => `${signal.label}: ${signal.rationale}`,
      ),
    };
  }
  if (validated.length > 0) {
    return {
      status: "review",
      reasons: validated.map(
        (signal) => `${signal.label}: ${signal.rationale}`,
      ),
    };
  }
  return { status: "clear", reasons: [] };
}

export function assertEnrichmentEvidenceBelongsToItem(
  output: ItemEnrichmentOutput,
  mediaAssetIds: ReadonlySet<string>,
): void {
  const references: VisualEvidence[] = [
    ...output.title.evidence,
    ...output.category.evidence,
    ...output.brand.evidence,
    ...output.model.evidence,
    ...output.condition.evidence,
    ...output.dimensions.flatMap((value) => value.evidence),
    ...output.specifications.flatMap((value) => value.evidence),
    ...output.accessories.flatMap((value) => value.evidence),
    ...output.defects.flatMap((value) => value.evidence),
    ...output.restrictedSignals.flatMap((value) => value.evidence),
  ];
  for (const assessment of output.mediaAssessments) {
    if (!mediaAssetIds.has(assessment.mediaAssetId)) {
      throw new Error("Enrichment referenced media outside the item");
    }
  }
  for (const reference of references) {
    if (!mediaAssetIds.has(reference.mediaAssetId)) {
      throw new Error("Enrichment evidence referenced media outside the item");
    }
  }
}
