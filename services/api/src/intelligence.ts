import {
  ItemEnrichmentOutputSchema,
  type ItemEnrichmentOutput,
  type Item,
} from "@localclear/domain";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputContent } from "openai/resources/responses/responses";

export interface EnrichmentMediaInput {
  mediaAssetId: string;
  readUrl: string;
}

export interface IntelligenceRequest {
  item: Pick<
    Item,
    | "title"
    | "category"
    | "brand"
    | "model"
    | "condition"
    | "accessories"
    | "defects"
  > & { barcode: string | null };
  media: EnrichmentMediaInput[];
}

export interface IntelligenceProvider {
  readonly providerName: string;
  readonly model: string;
  enrich(request: IntelligenceRequest): Promise<ItemEnrichmentOutput>;
}

export interface MediaReadUrlProvider {
  createReadUrl(storagePath: string, expiresInSeconds: number): Promise<string>;
}

export class IntelligenceUnavailableError extends Error {
  constructor() {
    super("Item intelligence is not configured");
    this.name = "IntelligenceUnavailableError";
  }
}

export class IntelligenceProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IntelligenceProviderError";
  }
}

export class UnavailableIntelligenceProvider implements IntelligenceProvider {
  readonly providerName = "unavailable";
  readonly model = "unavailable";

  async enrich(): Promise<ItemEnrichmentOutput> {
    throw new IntelligenceUnavailableError();
  }
}

const SYSTEM_PROMPT = `You assist a person clearing household items by analyzing only the attached item photos and the small amount of user-provided context.

Hard rules:
- Never invent a brand, model, material, dimension, compatibility claim, safety claim, certification, condition detail, accessory, or defect.
- Use provenance "image_derived" only when the exact fact is visibly supported. Use "inferred" for every uncertain assumption. Inferred facts will be blocked from publishing until a person confirms them.
- Every image-derived fact must cite at least one supplied mediaAssetId and a concise visible observation. Never cite an ID not supplied.
- Use null for brand or model when not visible. Keep confidence calibrated; uncertainty is expected.
- Transcribe visible text and barcodes conservatively. Do not reconstruct obscured text.
- Identify possible faces, documents, addresses, license plates, or other private details and recommend redaction.
- Score each supplied image from 0 to 1 for use as the lead listing photo. Prefer a sharp, well-lit, complete view of only the item with a clean background; explain the score briefly.
- Suggest only missing label, model-number, damage, scale, or accessory photos that would materially improve identification or buyer trust.
- Surface possible prohibited, recalled, unsafe, regulated, counterfeit, or hazardous-item signals. A signal is a preliminary screen, not a legal or safety conclusion.
- Write honest listing copy that calls out visible defects and does not claim facts beyond the evidence.
- Ask no more than three short unresolved questions, only when an answer materially affects identity, safety, condition, or value.
- Do not estimate prices and do not claim marketplace demand. Pricing is handled separately from approved comparable data.
- Choose the clearing recommendation for practical household clearance, and briefly explain it.
- Return only the requested structured output.`;

export class OpenAIIntelligenceProvider implements IntelligenceProvider {
  readonly providerName = "openai";
  readonly model: string;
  readonly #client: OpenAI;

  constructor(options: { apiKey?: string; model: string; client?: OpenAI }) {
    this.model = options.model;
    this.#client = options.client ?? new OpenAI({ apiKey: options.apiKey });
  }

  async enrich(request: IntelligenceRequest): Promise<ItemEnrichmentOutput> {
    const content: ResponseInputContent[] = [
      {
        type: "input_text",
        text: `User-provided context (not independently verified): ${JSON.stringify(
          request.item,
        )}\nAnalyze ${request.media.length} attached image(s). Each image is immediately preceded by its exact mediaAssetId.`,
      },
    ];
    for (const media of request.media) {
      content.push({
        type: "input_text",
        text: `mediaAssetId: ${media.mediaAssetId}`,
      });
      content.push({
        type: "input_image",
        image_url: media.readUrl,
        detail: "high",
      });
    }

    try {
      const response = await this.#client.responses.parse({
        model: this.model,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        text: {
          format: zodTextFormat(
            ItemEnrichmentOutputSchema,
            "localclear_item_enrichment",
          ),
        },
      });
      if (!response.output_parsed) {
        throw new IntelligenceProviderError(
          "The intelligence provider did not return structured output",
        );
      }
      return ItemEnrichmentOutputSchema.parse(response.output_parsed);
    } catch (error) {
      if (error instanceof IntelligenceProviderError) throw error;
      throw new IntelligenceProviderError(
        "The intelligence provider request failed",
        { cause: error },
      );
    }
  }
}
