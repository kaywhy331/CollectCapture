import { z } from "zod";
import { ClearingRecommendationSchema } from "./schemas.js";

export const ClearingAdviceSchema = z
  .object({
    recommendation: ClearingRecommendationSchema,
    rationale: z.string().trim().min(1).max(1_000),
    giveawayTitle: z.string().trim().min(1).max(240).nullable(),
    giveawayDescription: z.string().trim().min(1).max(2_000).nullable(),
    destinationCategory: z.string().trim().min(1).max(160).nullable(),
    destinationNotes: z.array(z.string().trim().min(1).max(500)).max(10),
  })
  .strict();
export type ClearingAdvice = z.infer<typeof ClearingAdviceSchema>;

const RECYCLING_CATEGORIES = [
  "electronics",
  "battery",
  "paint",
  "chemical",
  "appliance",
  "metal",
];

export function recommendClearingLane(input: {
  title: string;
  category: string;
  condition: string;
  expectedSaleValueCents: number;
  estimatedEffortMinutes: number;
  minimumWorthwhileHourlyCents?: number;
  restrictedOrUnsafe?: boolean;
}): ClearingAdvice {
  const minimumHourly = input.minimumWorthwhileHourlyCents ?? 1_500;
  const category = input.category.trim().toLowerCase();
  const title = input.title.trim();
  const effortValue = Math.max(1, input.estimatedEffortMinutes) * minimumHourly;
  const expectedReturnPerHour =
    (input.expectedSaleValueCents * 60) /
    Math.max(1, input.estimatedEffortMinutes);

  if (input.restrictedOrUnsafe) {
    const recycle = RECYCLING_CATEGORIES.some((value) =>
      category.includes(value),
    );
    return ClearingAdviceSchema.parse({
      recommendation: recycle ? "recycle" : "discard",
      rationale:
        "The item should not be listed until its safety or restriction status is resolved.",
      giveawayTitle: null,
      giveawayDescription: null,
      destinationCategory: recycle
        ? recyclingCategory(category)
        : "safe disposal",
      destinationNotes: [
        "Use an authorized local drop-off location.",
        "Do not leave restricted or unsafe items for unattended pickup.",
      ],
    });
  }

  if (
    input.condition === "poor" ||
    input.condition === "for_parts" ||
    RECYCLING_CATEGORIES.some((value) => category.includes(value))
  ) {
    return ClearingAdviceSchema.parse({
      recommendation: "recycle",
      rationale:
        "Condition and category make responsible recycling more useful than a local sale.",
      giveawayTitle: null,
      giveawayDescription: null,
      destinationCategory: recyclingCategory(category),
      destinationNotes: [
        "Remove personal data and batteries where applicable.",
        "Confirm the local facility accepts this material before drop-off.",
      ],
    });
  }

  if (
    input.expectedSaleValueCents <= 1_000 ||
    expectedReturnPerHour < minimumHourly ||
    input.expectedSaleValueCents * 60 < effortValue
  ) {
    return ClearingAdviceSchema.parse({
      recommendation: "give_away",
      rationale:
        "The likely sale value does not justify the estimated listing and meetup effort.",
      giveawayTitle: `FREE: ${title}`,
      giveawayDescription:
        `${title} is available free for local pickup. ` +
        `Please message only if you can collect it at an agreed time. No holds without a confirmed plan.`,
      destinationCategory: "community giveaway",
      destinationNotes: [
        "Use a public meetup or your saved safe pickup rules.",
      ],
    });
  }

  return ClearingAdviceSchema.parse({
    recommendation: "sell",
    rationale:
      "The expected local value is high enough to justify the estimated effort.",
    giveawayTitle: null,
    giveawayDescription: null,
    destinationCategory: null,
    destinationNotes: [],
  });
}

function recyclingCategory(category: string): string {
  if (category.includes("electronic")) return "electronics recycling";
  if (category.includes("battery")) return "household hazardous waste";
  if (category.includes("paint") || category.includes("chemical")) {
    return "household hazardous waste";
  }
  if (category.includes("appliance")) return "appliance recycling";
  if (category.includes("metal")) return "scrap metal recycling";
  return "local material recycling";
}
