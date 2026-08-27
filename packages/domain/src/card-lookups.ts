import { z } from "zod";
import { ConfidenceSchema } from "./schemas.js";

export const CardLookupCategorySchema = z.enum([
  "all",
  "pokemon",
  "magic",
  "yugioh",
  "other",
]);
export type CardLookupCategory = z.infer<typeof CardLookupCategorySchema>;

export const CardLookupRequestSchema = z
  .object({
    // Optional only for a text-only refinement (a non-empty `query`), so a
    // manual correction does not have to re-upload the crop it is
    // refining. A vision lookup (empty `query`) always requires the image.
    imageDataUrl: z
      .string()
      .min(32)
      .max(2_800_000)
      .regex(
        /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
        "Card image must be a base64 JPEG, PNG, or WebP data URL",
      )
      .optional(),
    query: z.string().trim().max(240).default(""),
    category: CardLookupCategorySchema.default("all"),
    limit: z.number().int().min(1).max(24).default(12),
  })
  .strict()
  .refine(
    (request) => request.imageDataUrl !== undefined || request.query !== "",
    {
      message: "Provide a card image, a text query, or both",
      path: ["imageDataUrl"],
    },
  );
export type CardLookupRequest = z.infer<typeof CardLookupRequestSchema>;

export const CardRecognitionSchema = z
  .object({
    source: z.enum(["vision", "user_query"]),
    category: CardLookupCategorySchema.exclude(["all"]),
    name: z.string().trim().min(1).max(160).nullable(),
    setName: z.string().trim().min(1).max(160).nullable(),
    collectorNumber: z.string().trim().min(1).max(80).nullable(),
    language: z.string().trim().min(2).max(35),
    visibleText: z.array(z.string().trim().min(1).max(240)).max(30),
    queries: z.array(z.string().trim().min(2).max(240)).min(1).max(6),
    confidence: ConfidenceSchema,
    provider: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(160),
  })
  .strict();
export type CardRecognition = z.infer<typeof CardRecognitionSchema>;

export const CardLookupCandidateSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    externalId: z.string().trim().min(1).max(160),
    provider: z.string().trim().min(1).max(80),
    category: z.string().trim().min(1).max(80),
    game: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(240),
    setName: z.string().trim().max(240),
    setCode: z.string().trim().max(80),
    number: z.string().trim().max(80),
    variant: z.string().trim().max(160),
    rarity: z.string().trim().max(160),
    year: z.string().trim().max(20),
    image: z.string().url().or(z.literal("")),
    imageSmall: z.string().url().or(z.literal("")),
    price: z.null(),
    priceOptions: z.array(z.never()).max(0),
    currency: z.literal("USD"),
    priceSource: z.literal(""),
    priceUrl: z.literal(""),
    priceUpdatedAt: z.literal(""),
    matchBucket: z.literal("likely"),
    matchScore: ConfidenceSchema,
    categoryId: z.number().int().positive(),
    groupId: z.number().int().positive(),
    productId: z.number().int().positive(),
  })
  .strict();
export type CardLookupCandidate = z.infer<typeof CardLookupCandidateSchema>;

export const CardLookupResultSchema = z
  .object({
    // Null only for a text-only refinement, where no image was submitted.
    contentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    imageRetained: z.literal(false),
    recognition: CardRecognitionSchema,
    candidates: z.array(CardLookupCandidateSchema).max(24),
    warnings: z.array(z.string().trim().min(1).max(500)).max(10),
  })
  .strict();
export type CardLookupResult = z.infer<typeof CardLookupResultSchema>;
