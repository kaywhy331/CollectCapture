import { z } from "zod";
import { EntityIdSchema, ItemSchema, type Item } from "./schemas.js";

export const BundleSuggestionSchema = z
  .object({
    itemIds: z.array(EntityIdSchema).min(2).max(10),
    suggestedTitle: z.string().trim().min(1).max(240),
    rationale: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type BundleSuggestion = z.infer<typeof BundleSuggestionSchema>;

export function suggestRelatedItemBundles(input: {
  targetItemId: string;
  items: readonly Item[];
}): BundleSuggestion[] {
  const items = input.items.map((item) => ItemSchema.parse(item));
  const target = items.find((item) => item.id === input.targetItemId);
  if (!target) throw new Error("Bundle target item was not found");
  const activeStates = new Set([
    "captured",
    "draft",
    "ready",
    "publishing",
    "partially_live",
    "live",
    "reserved",
  ]);
  const related = items
    .filter((item) => item.id !== target.id && activeStates.has(item.status))
    .map((item) => scoreRelated(target, item))
    .filter((value) => value.score >= 0.45)
    .sort((left, right) => right.score - left.score)
    .slice(0, 9);
  if (related.length === 0) return [];

  const groups = new Map<string, typeof related>();
  for (const candidate of related) {
    const key = [
      candidate.item.category.toLowerCase(),
      candidate.item.storageLocation?.toLowerCase() ?? "",
    ].join("|");
    const current = groups.get(key) ?? [];
    current.push(candidate);
    groups.set(key, current);
  }
  return [...groups.values()]
    .sort((left, right) => right[0]!.score - left[0]!.score)
    .slice(0, 3)
    .map((group) => {
      const selected = group.slice(0, 4);
      const category = selected[0]!.item.category;
      const rationales = [
        ...new Set(selected.flatMap((value) => value.reasons)),
      ].slice(0, 5);
      return BundleSuggestionSchema.parse({
        itemIds: [target.id, ...selected.map((value) => value.item.id)],
        suggestedTitle: `${selected.length + 1}-piece ${category.toLowerCase()} bundle`,
        rationale: rationales,
        confidence:
          selected.reduce((sum, value) => sum + value.score, 0) /
          selected.length,
      });
    });
}

function scoreRelated(target: Item, candidate: Item) {
  let score = 0;
  const reasons: string[] = [];
  if (target.category.toLowerCase() === candidate.category.toLowerCase()) {
    score += 0.45;
    reasons.push("same category");
  }
  if (
    target.brand &&
    candidate.brand &&
    target.brand.toLowerCase() === candidate.brand.toLowerCase()
  ) {
    score += 0.2;
    reasons.push("same brand");
  }
  if (
    target.storageLocation &&
    candidate.storageLocation &&
    target.storageLocation.toLowerCase() ===
      candidate.storageLocation.toLowerCase()
  ) {
    score += 0.15;
    reasons.push("stored together");
  }
  if (target.condition === candidate.condition) {
    score += 0.1;
    reasons.push("similar condition");
  }
  if (sharedTitleToken(target.title, candidate.title)) {
    score += 0.1;
    reasons.push("related item description");
  }
  if (
    target.clearingRecommendation === "bundle" ||
    candidate.clearingRecommendation === "bundle"
  ) {
    score += 0.1;
    reasons.push("bundle clearing recommendation");
  }
  return { item: candidate, score: Math.min(score, 1), reasons };
}

function sharedTitleToken(left: string, right: string): boolean {
  const meaningful = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 4),
    );
  const leftTokens = meaningful(left);
  return [...meaningful(right)].some((token) => leftTokens.has(token));
}
