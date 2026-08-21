import type { SpecificationValue } from "./schemas.js";

export interface SpecificationPublicationIssue {
  key: string;
  reason: "inferred" | "below_confidence_threshold";
  confidence: number;
}

export interface SpecificationPublicationResult {
  publishable: Record<string, SpecificationValue>;
  blocked: SpecificationPublicationIssue[];
}

export function classifySpecificationsForPublishing(
  specifications: Readonly<Record<string, SpecificationValue>>,
  confidenceThreshold = 0.85,
): SpecificationPublicationResult {
  if (confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("Confidence threshold must be between 0 and 1");
  }

  const publishable: Record<string, SpecificationValue> = {};
  const blocked: SpecificationPublicationIssue[] = [];

  for (const [key, specification] of Object.entries(specifications)) {
    if (specification.provenance === "user_confirmed") {
      publishable[key] = specification;
      continue;
    }
    if (specification.provenance === "inferred") {
      blocked.push({
        key,
        reason: "inferred",
        confidence: specification.confidence,
      });
      continue;
    }
    if (specification.confidence < confidenceThreshold) {
      blocked.push({
        key,
        reason: "below_confidence_threshold",
        confidence: specification.confidence,
      });
      continue;
    }
    publishable[key] = specification;
  }

  return { publishable, blocked };
}

export function assertSpecificationsPublishable(
  specifications: Readonly<Record<string, SpecificationValue>>,
  confidenceThreshold = 0.85,
): void {
  const result = classifySpecificationsForPublishing(
    specifications,
    confidenceThreshold,
  );
  if (result.blocked.length > 0) {
    const keys = result.blocked.map((issue) => issue.key).join(", ");
    throw new Error(`Listing contains unverified specifications: ${keys}`);
  }
}
