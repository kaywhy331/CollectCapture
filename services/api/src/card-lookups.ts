import { createHash } from "node:crypto";
import {
  CardLookupCandidateSchema,
  CardLookupRequestSchema,
  CardLookupResultSchema,
  CardRecognitionSchema,
  type CardLookupCandidate,
  type CardLookupCategory,
  type CardLookupRequest,
  type CardLookupResult,
  type CardRecognition,
} from "@localclear/domain";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputContent } from "openai/resources/responses/responses";
import { z } from "zod";
import { ApplicationError } from "./errors.js";
import {
  MediaVerificationError,
  verifyMediaBytes,
  type SupportedMediaType,
} from "./media-verification.js";

const MAX_CARD_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_RESPONSE_BYTES = 8 * 1024 * 1024;
const RECOGNITION_TIMEOUT_MS = 15_000;
const CATALOG_TOTAL_TIMEOUT_MS = 14_000;

const VisionRecognitionSchema = z
  .object({
    category: z.enum(["pokemon", "magic", "yugioh", "other"]),
    name: z.string().trim().min(1).max(160).nullable(),
    setName: z.string().trim().min(1).max(160).nullable(),
    collectorNumber: z.string().trim().min(1).max(80).nullable(),
    language: z.string().trim().min(2).max(35),
    visibleText: z.array(z.string().trim().min(1).max(240)).max(30),
    queries: z.array(z.string().trim().min(2).max(240)).min(1).max(6),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const CARD_RECOGNITION_PROMPT = `Analyze one cropped collectible card image for catalog search.

Return only visible, conservative recognition evidence. Identify the likely game family, printed card name, set name, collector/card number, language, and short catalog search queries. Put the most specific reliable query first and include progressively simpler queries only when useful.

Hard rules:
- Never claim an exact catalog printing or authenticity from appearance alone.
- Never invent obscured text, a set, collector number, edition, finish, rarity, or language.
- Use null when a field is not visibly supported.
- Queries must be derived only from visible text and may combine name, set, and collector number.
- Treat logos, copyright boilerplate, rules text, and random OCR fragments as weak evidence.
- Confidence measures the visible recognition evidence, not card value, condition, authenticity, or catalog-match certainty.`;

export interface CardRecognitionProvider {
  readonly providerName: string;
  readonly model: string;
  recognize(input: {
    imageDataUrl: string;
    categoryHint: CardLookupCategory;
  }): Promise<CardRecognition>;
}

export class OpenAICardRecognitionProvider implements CardRecognitionProvider {
  readonly providerName = "openai";
  readonly model: string;
  readonly #client: OpenAI;

  constructor(options: { apiKey?: string; model: string; client?: OpenAI }) {
    this.model = options.model;
    this.#client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        timeout: RECOGNITION_TIMEOUT_MS,
        maxRetries: 0,
      });
  }

  async recognize(input: {
    imageDataUrl: string;
    categoryHint: CardLookupCategory;
  }): Promise<CardRecognition> {
    const content: ResponseInputContent[] = [
      {
        type: "input_text",
        text:
          input.categoryHint === "all"
            ? "Recognize this card for catalog lookup."
            : `Recognize this card for ${input.categoryHint} catalog lookup. Treat the category as a user hint, not verified evidence.`,
      },
      {
        type: "input_image",
        image_url: input.imageDataUrl,
        detail: "high",
      },
    ];
    try {
      const response = await this.#client.responses.parse({
        model: this.model,
        store: false,
        input: [
          { role: "system", content: CARD_RECOGNITION_PROMPT },
          { role: "user", content },
        ],
        text: {
          format: zodTextFormat(
            VisionRecognitionSchema,
            "collectcapture_card_recognition",
          ),
        },
      });
      if (!response.output_parsed) {
        throw new Error(
          "The recognition provider returned no structured output",
        );
      }
      return CardRecognitionSchema.parse({
        ...VisionRecognitionSchema.parse(response.output_parsed),
        source: "vision",
        provider: this.providerName,
        model: this.model,
      });
    } catch (error) {
      throw new ApplicationError(
        502,
        "card_recognition_failed",
        "CollectCapture could not recognize this card image",
        error instanceof Error ? { cause: error.name } : undefined,
      );
    }
  }
}

export interface CardCatalogSearchResult {
  candidates: CardLookupCandidate[];
  warnings: string[];
}

export interface CardCatalogProvider {
  search(input: {
    recognition: CardRecognition;
    category: CardLookupCategory;
    limit: number;
    authorization: string;
  }): Promise<CardCatalogSearchResult>;
}

interface TcgcsvCatalogOptions {
  baseUrl: string | URL;
  fetchImpl?: typeof fetch;
}

export class TcgcsvCardCatalogProvider implements CardCatalogProvider {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;

  constructor(options: TcgcsvCatalogOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    if (
      this.#baseUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(this.#baseUrl.hostname)
    ) {
      throw new Error("The card catalog URL must use HTTPS");
    }
    if (
      this.#baseUrl.username ||
      this.#baseUrl.password ||
      this.#baseUrl.search ||
      this.#baseUrl.hash
    ) {
      throw new Error(
        "The card catalog URL must not contain credentials, a query, or a fragment",
      );
    }
    if (!this.#baseUrl.pathname.endsWith("/")) this.#baseUrl.pathname += "/";
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async search(input: {
    recognition: CardRecognition;
    category: CardLookupCategory;
    limit: number;
    authorization: string;
  }): Promise<CardCatalogSearchResult> {
    const warnings = new Set<string>();
    const candidates = new Map<string, CardLookupCandidate>();
    let successfulRequests = 0;
    let failedRequests = 0;
    const categoryIds = catalogCategoryIds(input.category);
    const signal = AbortSignal.timeout(CATALOG_TOTAL_TIMEOUT_MS);

    for (const query of uniqueQueries(input.recognition.queries)) {
      if (signal.aborted) break;
      const settled = await Promise.allSettled(
        categoryIds.map((categoryId) =>
          this.#searchOnce(query, categoryId, input.authorization, signal),
        ),
      );
      settled.forEach((result) => {
        if (result.status === "rejected") {
          failedRequests += 1;
          const warning =
            result.reason instanceof Error
              ? result.reason.message
              : "The card catalog request failed";
          const boundedWarning = warning.trim().slice(0, 500);
          if (boundedWarning) warnings.add(boundedWarning);
          return;
        }
        successfulRequests += 1;
        for (const product of result.value) {
          const candidate = normalizeTcgcsvCandidate(
            product,
            input.recognition,
          );
          if (candidate) candidates.set(candidate.externalId, candidate);
        }
      });
      if (candidates.size >= input.limit) break;
    }

    if (successfulRequests === 0 && failedRequests > 0) {
      throw new ApplicationError(
        503,
        "card_catalog_unavailable",
        "The card catalog is temporarily unavailable",
      );
    }

    return {
      candidates: [...candidates.values()]
        .sort(
          (left, right) =>
            right.matchScore - left.matchScore ||
            left.name.localeCompare(right.name),
        )
        .slice(0, input.limit),
      warnings: [...warnings].slice(0, 10),
    };
  }

  async #searchOnce(
    query: string,
    categoryId: number | null,
    authorization: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const url = new URL("catalog/search", this.#baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "50");
    if (categoryId !== null) {
      url.searchParams.set("category_id", String(categoryId));
    }
    const response = await this.#fetch(url, {
      headers: { accept: "application/json", authorization },
      signal,
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_CATALOG_RESPONSE_BYTES
    ) {
      throw new Error("The card catalog response exceeded its size limit");
    }
    const text = await readBoundedText(response, MAX_CATALOG_RESPONSE_BYTES);
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("The card catalog returned invalid JSON");
    }
    if (!response.ok) {
      const detail = record(payload);
      throw new Error(
        response.status === 401
          ? "The card catalog rejected the signed-in session"
          : stringValue(detail.error) ||
              `The card catalog returned HTTP ${response.status}`,
      );
    }
    const products = record(payload).products;
    return Array.isArray(products)
      ? products.filter(isRecord).slice(0, 200)
      : [];
  }
}

export interface CardLookupHandler {
  lookup(
    request: CardLookupRequest,
    context: { authorization: string },
  ): Promise<CardLookupResult>;
}

export class StatelessCardLookupService implements CardLookupHandler {
  constructor(
    readonly recognitionProvider: CardRecognitionProvider,
    readonly catalogProvider: CardCatalogProvider,
  ) {}

  async lookup(
    rawRequest: CardLookupRequest,
    context: { authorization: string },
  ): Promise<CardLookupResult> {
    const request = CardLookupRequestSchema.parse(rawRequest);
    const image = verifiedCardImage(request.imageDataUrl);
    const recognition = request.query
      ? manualRecognition(request.query, request.category)
      : await this.recognitionProvider.recognize({
          imageDataUrl: request.imageDataUrl,
          categoryHint: request.category,
        });
    const category =
      request.category === "all" ? recognition.category : request.category;
    const catalog = await this.catalogProvider.search({
      recognition,
      category,
      limit: request.limit,
      authorization: context.authorization,
    });
    return CardLookupResultSchema.parse({
      contentSha256: image.contentSha256,
      imageRetained: false,
      recognition,
      candidates: catalog.candidates,
      warnings: catalog.warnings,
    });
  }
}

function verifiedCardImage(dataUrl: string) {
  const match =
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      dataUrl,
    );
  if (!match) {
    throw new ApplicationError(
      400,
      "invalid_card_image",
      "Card image must be a base64 JPEG, PNG, or WebP data URL",
    );
  }
  const encoded = match[2]!;
  if (encoded.length % 4 !== 0) {
    throw new ApplicationError(
      400,
      "invalid_card_image",
      "Card image base64 is malformed",
    );
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new ApplicationError(
      400,
      "invalid_card_image",
      "Card image base64 is malformed",
    );
  }
  const mediaType = match[1] as SupportedMediaType;
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    return verifyMediaBytes(
      bytes,
      { declaredMediaType: mediaType, expectedSha256 },
      MAX_CARD_IMAGE_BYTES,
    );
  } catch (error) {
    if (error instanceof MediaVerificationError) {
      const status = error.code === "media_too_large" ? 413 : 422;
      throw new ApplicationError(status, error.code, error.message);
    }
    throw error;
  }
}

function manualRecognition(
  query: string,
  category: CardLookupCategory,
): CardRecognition {
  return CardRecognitionSchema.parse({
    source: "user_query",
    category: category === "all" ? "other" : category,
    name: null,
    setName: null,
    collectorNumber: null,
    language: "und",
    visibleText: [],
    queries: [query],
    confidence: 1,
    provider: "collector",
    model: "manual-query",
  });
}

function catalogCategoryIds(category: CardLookupCategory): (number | null)[] {
  if (category === "pokemon") return [3, 85];
  if (category === "magic") return [1];
  if (category === "yugioh") return [2];
  return [null];
}

function uniqueQueries(queries: readonly string[]): string[] {
  return [
    ...new Set(
      queries.map((query) => query.trim()).filter((query) => query.length >= 2),
    ),
  ].slice(0, 6);
}

function normalizeTcgcsvCandidate(
  product: Record<string, unknown>,
  recognition: CardRecognition,
): CardLookupCandidate | null {
  const categoryId = positiveInteger(product.categoryId);
  const groupId = positiveInteger(product.groupId);
  const productId = positiveInteger(product.productId);
  if (!categoryId || !groupId || !productId) return null;
  const name =
    stringValue(product.name) ||
    stringValue(product.cleanName) ||
    `Product ${productId}`;
  const extended = Array.isArray(product.extendedData)
    ? product.extendedData.filter(isRecord)
    : [];
  const number =
    stringValue(product.cardNumber) ||
    extendedValue(extended, ["number", "card number"]);
  const rarity =
    stringValue(product.rarity) || extendedValue(extended, ["rarity"]);
  const prices = Array.isArray(product.prices)
    ? product.prices.filter(isRecord)
    : [];
  const variant = stringValue(prices[0]?.subtypeName);
  const publishedOn =
    stringValue(product.groupPublishedOn) ||
    stringValue(product.publishedOn) ||
    stringValue(product.releaseDate);
  const externalId = `${categoryId}:${groupId}:${productId}`;
  const candidate = {
    id: `tcgcsv:${externalId}`,
    externalId,
    provider: "tcgcsv",
    category: `tcgcsv-category-${categoryId}`,
    game: categoryName(categoryId, stringValue(product.categoryName)),
    name,
    setName: stringValue(product.groupName),
    setCode: stringValue(product.groupAbbreviation),
    number,
    variant,
    rarity,
    year: /^\d{4}/.exec(publishedOn)?.[0] ?? "",
    image: `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_1000x1000.jpg`,
    imageSmall: `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_400x400.jpg`,
    price: null,
    priceOptions: [],
    currency: "USD",
    priceSource: "",
    priceUrl: "",
    priceUpdatedAt: "",
    matchBucket: "likely",
    matchScore: scoreCandidate(
      { name, setName: stringValue(product.groupName), number },
      recognition,
    ),
    categoryId,
    groupId,
    productId,
  } as const;
  return CardLookupCandidateSchema.parse(candidate);
}

function scoreCandidate(
  candidate: { name: string; setName: string; number: string },
  recognition: CardRecognition,
): number {
  const recognizedName = normalized(recognition.name ?? "");
  const candidateName = normalized(candidate.name);
  const recognizedSet = normalized(recognition.setName ?? "");
  const candidateSet = normalized(candidate.setName);
  const recognizedNumber = normalizedNumber(recognition.collectorNumber ?? "");
  const candidateNumber = normalizedNumber(candidate.number);
  const queryTokens = new Set(
    normalized(recognition.queries[0] ?? "")
      .split(" ")
      .filter(Boolean),
  );
  const candidateTokens = new Set(
    normalized(`${candidate.name} ${candidate.setName} ${candidate.number}`)
      .split(" ")
      .filter(Boolean),
  );
  const overlap = [...queryTokens].filter((token) =>
    candidateTokens.has(token),
  );
  let score = queryTokens.size ? overlap.length / queryTokens.size : 0.35;
  if (recognizedName && candidateName === recognizedName)
    score = Math.max(score, 0.9);
  else if (
    recognizedName &&
    (candidateName.includes(recognizedName) ||
      recognizedName.includes(candidateName))
  ) {
    score = Math.max(score, 0.78);
  }
  if (recognizedSet && candidateSet === recognizedSet) score += 0.05;
  if (
    recognizedNumber &&
    candidateNumber &&
    recognizedNumber === candidateNumber
  ) {
    score += 0.12;
  }
  return Math.max(0.28, Math.min(0.99, Number(score.toFixed(4))));
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedNumber(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^0+(?=\d)/, "");
}

function categoryName(categoryId: number, fallback: string): string {
  if (fallback) return fallback;
  if (categoryId === 1) return "Magic: The Gathering";
  if (categoryId === 2) return "YuGiOh";
  if (categoryId === 3) return "Pokemon";
  if (categoryId === 85) return "Pokemon Japan";
  return `Game category ${categoryId}`;
}

function extendedValue(
  entries: Record<string, unknown>[],
  names: string[],
): string {
  const expected = new Set(names.map((name) => name.toLowerCase()));
  const match = entries.find((entry) =>
    expected.has(
      (stringValue(entry.name) || stringValue(entry.displayName)).toLowerCase(),
    ),
  );
  return match ? stringValue(match.value) : "";
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new Error("The card catalog response exceeded its size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
