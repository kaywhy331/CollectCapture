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
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
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
const MAX_RECOGNITION_RESPONSE_BYTES = 512 * 1024;
/** Exported so runtime startup can warn when a configured provider timeout
 * plus this catalog budget would exceed the Cloudflare edge deadline. */
export const RECOGNITION_TIMEOUT_MS = 15_000;
export const CATALOG_TOTAL_TIMEOUT_MS = 14_000;

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
- Confidence measures the visible recognition evidence, not card value, condition, authenticity, or catalog-match certainty.
- If the visible card text is not Latin script, include at least one romanized or English query alongside the native-script queries -- the catalog it searches is indexed in Latin script.`;

export interface CardRecognitionProvider {
  readonly providerName: string;
  readonly model: string;
  recognize(input: {
    imageDataUrl: string;
    categoryHint: CardLookupCategory;
    signal?: AbortSignal | undefined;
  }): Promise<CardRecognition>;
}

/**
 * Marks a recognition failure that happened AFTER a provider's HTTP/SDK call
 * itself succeeded -- the response arrived, but its content could not be
 * parsed as JSON or did not validate against {@link VisionRecognitionSchema}.
 * Distinguishing this from a network/timeout/auth failure lets
 * {@link withOneValidationRetry} retry only this class of failure (G5), and
 * lets the provider catch sites classify it as `card_recognition_invalid_output`
 * rather than `_unavailable`/`_timeout` (G16).
 */
export class RecognitionOutputValidationError extends Error {
  constructor(cause: unknown) {
    super("The recognition provider's output did not parse or validate", {
      cause,
    });
    this.name = "RecognitionOutputValidationError";
  }
}

/**
 * Runs a provider attempt once, then retries it exactly once more if (and
 * only if) it failed with a {@link RecognitionOutputValidationError} -- a
 * malformed model response is often a one-off sampling fluke, unlike a
 * timeout or a network/auth failure, which a second identical call would
 * not fix (G5b). Never retries once the caller's signal is already
 * aborted: the client is gone, so spending another provider call (and, for
 * a paid provider, its cost) on nobody would be wasteful.
 */
async function withOneValidationRetry<T>(
  signal: AbortSignal | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof RecognitionOutputValidationError)) throw error;
    if (signal?.aborted) throw error;
    return await attempt();
  }
}

/**
 * A lenient pass over a provider's raw (already-JSON-parsed) recognition
 * object, applied before the strict {@link VisionRecognitionSchema} parse
 * (G5a): trims every string, clamps free-text fields and array lengths to
 * the schema's own bounds instead of letting an over-long value fail
 * validation outright, and drops/dedupes queries that could never satisfy
 * the schema's 2-character minimum. This never invents or corrects
 * content -- it only removes whitespace and truncates/drops what the
 * strict schema would have rejected anyway, so a still-malformed payload
 * fails validation exactly as before and falls through to the retry (G5b).
 */
function salvageRecognitionPayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const salvaged: Record<string, unknown> = { ...raw };
  const stringBounds: Record<string, number> = {
    name: 160,
    setName: 160,
    collectorNumber: 80,
    language: 35,
  };
  for (const [field, maxLength] of Object.entries(stringBounds)) {
    const value = salvaged[field];
    if (typeof value === "string") {
      salvaged[field] = clampToLength(value.trim(), maxLength);
    }
  }
  if (Array.isArray(salvaged.visibleText)) {
    salvaged.visibleText = salvaged.visibleText
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => clampToLength(entry.trim(), 240))
      .slice(0, 30);
  }
  if (Array.isArray(salvaged.queries)) {
    const cleaned = salvaged.queries
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => clampToLength(entry.trim(), 240))
      .filter((entry) => entry.length >= 2);
    salvaged.queries = [...new Set(cleaned)].slice(0, 6);
  }
  return salvaged;
}

/**
 * The card_recognition_* error taxonomy (G16). All still respond `502` --
 * this only replaces one generic code with one that tells CollectFolio
 * whether the failure is worth retrying automatically
 * (`_timeout`/`_unavailable`), is an operator configuration problem
 * (`_misconfigured`), or is an output CollectCapture itself could not use
 * (`_invalid_output`, the post-G5 salvage-and-retry still failing). A
 * failure that does not fit any of those keeps today's generic
 * `card_recognition_failed` code. See `docs/collectfolio-card-lookup.md`
 * for the retry-vs-report guidance CollectFolio should apply per code.
 */
export type CardRecognitionFailureCode =
  | "card_recognition_timeout"
  | "card_recognition_unavailable"
  | "card_recognition_misconfigured"
  | "card_recognition_invalid_output"
  | "card_recognition_failed";

const RECOGNITION_FAILURE_MESSAGES: Record<CardRecognitionFailureCode, string> =
  {
    card_recognition_timeout:
      "The card recognition provider took too long to respond. Please try again.",
    card_recognition_unavailable:
      "The card recognition provider is temporarily unavailable. Please try again shortly.",
    card_recognition_misconfigured:
      "The card recognition provider is not configured correctly. Please contact support.",
    card_recognition_invalid_output:
      "The card recognition provider returned output CollectCapture could not use. Please try again.",
    card_recognition_failed:
      "CollectCapture could not recognize this card image",
  };

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Carries the upstream HTTP status of a raw-fetch provider's (Ollama/Groq)
 * non-OK response so the catch site can classify it (G16) without
 * re-parsing the already-consumed response.
 */
class RecognitionUpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RecognitionUpstreamError";
  }
}

/** Classifies an Ollama/Groq recognition failure into the G16 taxonomy. */
function classifyFetchRecognitionFailure(
  error: unknown,
): CardRecognitionFailureCode {
  if (error instanceof RecognitionOutputValidationError) {
    return "card_recognition_invalid_output";
  }
  if (isAbortError(error)) return "card_recognition_timeout";
  if (error instanceof RecognitionUpstreamError) {
    if ([401, 403, 404].includes(error.status)) {
      return "card_recognition_misconfigured";
    }
    if (error.status === 429 || error.status >= 500) {
      return "card_recognition_unavailable";
    }
    return "card_recognition_failed";
  }
  // Node's fetch (undici) throws a bare TypeError for DNS/connect failures
  // and other transport-level problems -- never for a validation failure,
  // which is always wrapped above.
  if (error instanceof TypeError) return "card_recognition_unavailable";
  return "card_recognition_failed";
}

/** Classifies an OpenAI SDK recognition failure into the G16 taxonomy. */
function classifyOpenAIRecognitionFailure(
  error: unknown,
): CardRecognitionFailureCode {
  if (error instanceof RecognitionOutputValidationError) {
    return "card_recognition_invalid_output";
  }
  if (
    error instanceof APIUserAbortError ||
    error instanceof APIConnectionTimeoutError ||
    isAbortError(error)
  ) {
    return "card_recognition_timeout";
  }
  if (
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError ||
    error instanceof NotFoundError
  ) {
    return "card_recognition_misconfigured";
  }
  if (
    error instanceof RateLimitError ||
    error instanceof InternalServerError ||
    error instanceof APIConnectionError
  ) {
    return "card_recognition_unavailable";
  }
  return "card_recognition_failed";
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
    signal?: AbortSignal | undefined;
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
    const attempt = async (): Promise<CardRecognition> => {
      const response = await this.#client.responses.parse(
        {
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
        },
        // The client's own `timeout: RECOGNITION_TIMEOUT_MS` already bounds
        // this call; the SDK combines that with a passed-in signal itself.
        { signal: input.signal },
      );
      if (!response.output_parsed) {
        throw new RecognitionOutputValidationError(
          new Error("The recognition provider returned no structured output"),
        );
      }
      let recognition: z.infer<typeof VisionRecognitionSchema>;
      try {
        recognition = VisionRecognitionSchema.parse(
          salvageRecognitionPayload(response.output_parsed),
        );
      } catch (error) {
        throw new RecognitionOutputValidationError(error);
      }
      return CardRecognitionSchema.parse({
        ...recognition,
        source: "vision",
        provider: this.providerName,
        model: this.model,
      });
    };
    try {
      return await withOneValidationRetry(input.signal, attempt);
    } catch (error) {
      const code = classifyOpenAIRecognitionFailure(error);
      throw new ApplicationError(
        502,
        code,
        RECOGNITION_FAILURE_MESSAGES[code],
        error instanceof Error ? { cause: error.name } : undefined,
      );
    }
  }
}

interface OllamaCardRecognitionOptions {
  baseUrl: string | URL;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const OllamaChatResponseSchema = z
  .object({
    message: z.object({ content: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export class OllamaCardRecognitionProvider implements CardRecognitionProvider {
  readonly providerName = "ollama";
  readonly model: string;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: OllamaCardRecognitionOptions) {
    this.model = options.model.trim();
    if (!this.model) throw new Error("The Ollama model must not be empty");
    this.#baseUrl = validatedOllamaBaseUrl(options.baseUrl);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#apiKey = options.apiKey?.trim();
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000) {
      throw new Error("The Ollama timeout must be at least 1000 milliseconds");
    }
  }

  async recognize(input: {
    imageDataUrl: string;
    categoryHint: CardLookupCategory;
    signal?: AbortSignal | undefined;
  }): Promise<CardRecognition> {
    const attempt = async (): Promise<CardRecognition> => {
      const encodedImage = encodedCardImage(input.imageDataUrl);
      const response = await this.#fetch(new URL("api/chat", this.#baseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          keep_alive: -1,
          format: z.toJSONSchema(VisionRecognitionSchema),
          options: { temperature: 0 },
          messages: [
            { role: "system", content: CARD_RECOGNITION_PROMPT },
            {
              role: "user",
              content: recognitionInstruction(input.categoryHint),
              images: [encodedImage],
            },
          ],
        }),
        signal: combinedSignal(input.signal, this.#timeoutMs),
      });
      const responseText = await readBoundedText(
        response,
        MAX_RECOGNITION_RESPONSE_BYTES,
        "The recognition provider response exceeded its size limit",
      );
      if (!response.ok) {
        throw new RecognitionUpstreamError(
          response.status,
          `The recognition provider returned HTTP ${response.status}`,
        );
      }
      let recognition: z.infer<typeof VisionRecognitionSchema>;
      try {
        const envelope = OllamaChatResponseSchema.parse(
          JSON.parse(responseText),
        );
        recognition = VisionRecognitionSchema.parse(
          salvageRecognitionPayload(JSON.parse(envelope.message.content)),
        );
      } catch (error) {
        throw new RecognitionOutputValidationError(error);
      }
      return CardRecognitionSchema.parse({
        ...recognition,
        source: "vision",
        provider: this.providerName,
        model: this.model,
      });
    };
    try {
      return await withOneValidationRetry(input.signal, attempt);
    } catch (error) {
      const code = classifyFetchRecognitionFailure(error);
      throw new ApplicationError(
        502,
        code,
        RECOGNITION_FAILURE_MESSAGES[code],
        error instanceof Error ? { cause: error.name } : undefined,
      );
    }
  }
}

interface GroqCardRecognitionOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  reasoningEffort?: string;
  /** `"json_schema"` asks Groq to enforce the recognition schema natively;
   * defaults to today's `"json_object"` mode, which relies on the
   * schema-in-prompt text plus local Zod validation (G5c). */
  responseFormat?: "json_object" | "json_schema";
  /** Defaults to today's hardcoded 2048 (G5d). */
  maxCompletionTokens?: number;
}

const GroqChatResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().min(1) }).passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export class GroqCardRecognitionProvider implements CardRecognitionProvider {
  readonly providerName = "groq";
  readonly model: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #reasoningEffort: string;
  readonly #responseFormat: "json_object" | "json_schema";
  readonly #maxCompletionTokens: number;

  constructor(options: GroqCardRecognitionOptions) {
    this.model = options.model.trim();
    this.#apiKey = options.apiKey.trim();
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#reasoningEffort = (options.reasoningEffort ?? "none").trim();
    this.#responseFormat = options.responseFormat ?? "json_object";
    this.#maxCompletionTokens = options.maxCompletionTokens ?? 2_048;
    if (!this.model) throw new Error("The Groq model must not be empty");
    if (!this.#apiKey) throw new Error("The Groq API key must not be empty");
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000) {
      throw new Error("The Groq timeout must be at least 1000 milliseconds");
    }
    if (
      !Number.isSafeInteger(this.#maxCompletionTokens) ||
      this.#maxCompletionTokens < 1
    ) {
      throw new Error(
        "The Groq max completion tokens must be a positive integer",
      );
    }
  }

  async recognize(input: {
    imageDataUrl: string;
    categoryHint: CardLookupCategory;
    signal?: AbortSignal | undefined;
  }): Promise<CardRecognition> {
    const attempt = async (): Promise<CardRecognition> => {
      const response = await this.#fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            temperature: 0,
            max_completion_tokens: this.#maxCompletionTokens,
            ...(this.#reasoningEffort
              ? { reasoning_effort: this.#reasoningEffort }
              : {}),
            response_format:
              this.#responseFormat === "json_schema"
                ? {
                    type: "json_schema",
                    json_schema: {
                      name: "collectcapture_card_recognition",
                      strict: true,
                      schema: z.toJSONSchema(VisionRecognitionSchema),
                    },
                  }
                : { type: "json_object" },
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `${CARD_RECOGNITION_PROMPT}\n\n${recognitionInstruction(input.categoryHint)}\n\nReturn a JSON object matching this JSON Schema exactly:\n${JSON.stringify(z.toJSONSchema(VisionRecognitionSchema))}`,
                  },
                  {
                    type: "image_url",
                    image_url: { url: input.imageDataUrl },
                  },
                ],
              },
            ],
          }),
          signal: combinedSignal(input.signal, this.#timeoutMs),
        },
      );
      const responseText = await readBoundedText(
        response,
        MAX_RECOGNITION_RESPONSE_BYTES,
        "The recognition provider response exceeded its size limit",
      );
      if (!response.ok) {
        throw new RecognitionUpstreamError(
          response.status,
          `The recognition provider returned HTTP ${response.status}`,
        );
      }
      let recognition: z.infer<typeof VisionRecognitionSchema>;
      try {
        const envelope = GroqChatResponseSchema.parse(JSON.parse(responseText));
        recognition = VisionRecognitionSchema.parse(
          salvageRecognitionPayload(
            JSON.parse(envelope.choices[0]!.message.content),
          ),
        );
      } catch (error) {
        throw new RecognitionOutputValidationError(error);
      }
      return CardRecognitionSchema.parse({
        ...recognition,
        source: "vision",
        provider: this.providerName,
        model: this.model,
      });
    };
    try {
      return await withOneValidationRetry(input.signal, attempt);
    } catch (error) {
      const code = classifyFetchRecognitionFailure(error);
      throw new ApplicationError(
        502,
        code,
        RECOGNITION_FAILURE_MESSAGES[code],
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
    signal?: AbortSignal | undefined;
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
      !["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(
        this.#baseUrl.hostname,
      )
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
    signal?: AbortSignal | undefined;
  }): Promise<CardCatalogSearchResult> {
    const warnings = new Set<string>();
    const candidates = new Map<string, CardLookupCandidate>();
    let successfulRequests = 0;
    let failedRequests = 0;
    const categoryIds = catalogCategoryIds(
      input.category,
      input.recognition.language,
    );
    const signal = combinedSignal(input.signal, CATALOG_TOTAL_TIMEOUT_MS);

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
          const outcome = normalizeTcgcsvCandidate(product, input.recognition);
          if (outcome.ok) {
            candidates.set(outcome.candidate.externalId, outcome.candidate);
          } else if (outcome.reason === "malformed") {
            warnings.add(
              "catalog_candidate_skipped: a catalog row did not match the expected candidate shape and was skipped",
            );
          }
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

/**
 * Thrown by {@link StatelessCardLookupService.lookup} when the request's
 * `signal` was already aborted by the time a phase's provider call failed.
 * This is a distinct outcome from a provider failure: the caller (the HTTP
 * route) should log it as `client_disconnected`, never as a recognition or
 * catalog error, and must not attempt to write a response body.
 */
export class ClientDisconnectedError extends Error {
  constructor() {
    super("The client disconnected before the card lookup finished");
    this.name = "ClientDisconnectedError";
  }
}

/** Reported once per phase that actually ran (G12a) -- a manual-query
 * lookup never runs a `recognition` phase, so no timing is reported for
 * it. Fires whether the phase succeeded or failed. */
export interface CardLookupPhaseTiming {
  phase: "recognition" | "catalog";
  durationMs: number;
}

export interface CardLookupHandler {
  /** Configuration facts about this handler's recognition provider, for
   * telemetry (G12a) -- not tied to any one request's outcome. A caller
   * that is not a {@link StatelessCardLookupService} (a test mock, for
   * example) simply omits these. */
  readonly recognitionProviderName?: string;
  readonly recognitionModel?: string;
  lookup(
    request: CardLookupRequest,
    context: {
      authorization: string;
      signal?: AbortSignal | undefined;
      onPhaseComplete?: (timing: CardLookupPhaseTiming) => void;
    },
  ): Promise<CardLookupResult>;
}

export class StatelessCardLookupService implements CardLookupHandler {
  readonly #minCardImageDimension: number;

  constructor(
    readonly recognitionProvider: CardRecognitionProvider,
    readonly catalogProvider: CardCatalogProvider,
    options: { minCardImageDimension?: number } = {},
  ) {
    this.#minCardImageDimension = options.minCardImageDimension ?? 0;
  }

  get recognitionProviderName(): string {
    return this.recognitionProvider.providerName;
  }

  get recognitionModel(): string {
    return this.recognitionProvider.model;
  }

  async lookup(
    request: CardLookupRequest,
    context: {
      authorization: string;
      signal?: AbortSignal | undefined;
      onPhaseComplete?: (timing: CardLookupPhaseTiming) => void;
    },
  ): Promise<CardLookupResult> {
    if (context.signal?.aborted) throw new ClientDisconnectedError();
    const image = verifiedCardImage(
      request.imageDataUrl,
      this.#minCardImageDimension,
    );
    let recognition: CardRecognition;
    if (request.query) {
      recognition = manualRecognition(request.query, request.category);
    } else {
      const recognitionStartedAt = performance.now();
      try {
        recognition = await this.recognitionProvider.recognize({
          imageDataUrl: request.imageDataUrl,
          categoryHint: request.category,
          signal: context.signal,
        });
      } catch (error) {
        throw disconnectedOr(error, context.signal);
      } finally {
        context.onPhaseComplete?.({
          phase: "recognition",
          durationMs: performance.now() - recognitionStartedAt,
        });
      }
    }
    // Re-checked explicitly (rather than relying on each catalog provider
    // to notice on its own) so a signal that aborted between phases -- or
    // one a manual-query lookup never gave a provider fetch to observe --
    // still stops the catalog phase from starting at all.
    if (context.signal?.aborted) throw new ClientDisconnectedError();
    const category =
      request.category === "all" ? recognition.category : request.category;
    let catalog: CardCatalogSearchResult;
    const catalogStartedAt = performance.now();
    try {
      catalog = await this.catalogProvider.search({
        recognition,
        category,
        limit: request.limit,
        authorization: context.authorization,
        signal: context.signal,
      });
    } catch (error) {
      throw disconnectedOr(error, context.signal);
    } finally {
      context.onPhaseComplete?.({
        phase: "catalog",
        durationMs: performance.now() - catalogStartedAt,
      });
    }
    return CardLookupResultSchema.parse({
      contentSha256: image.contentSha256,
      imageRetained: false,
      recognition,
      candidates: catalog.candidates,
      warnings: catalog.warnings,
    });
  }

  /**
   * Validates unknown input against {@link CardLookupRequestSchema} before
   * delegating to {@link lookup}. The HTTP route validates the request body
   * itself and calls `lookup` directly so a request is parsed only once; use
   * this entry point only for a caller that has not already validated its
   * input shape.
   */
  async lookupUnvalidated(
    rawRequest: unknown,
    context: { authorization: string; signal?: AbortSignal | undefined },
  ): Promise<CardLookupResult> {
    return this.lookup(CardLookupRequestSchema.parse(rawRequest), context);
  }
}

/**
 * Reclassifies any phase failure as a {@link ClientDisconnectedError} when
 * the caller's signal is already aborted -- the client is gone, so the
 * original provider/catalog error (which may itself just be an AbortError)
 * is no longer meaningful and must not be logged or reported as a provider
 * failure.
 */
function disconnectedOr(error: unknown, signal: AbortSignal | undefined) {
  return signal?.aborted ? new ClientDisconnectedError() : error;
}

function verifiedCardImage(dataUrl: string, minDimension = 0) {
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
      minDimension,
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

function catalogCategoryIds(
  category: CardLookupCategory,
  language: string,
): (number | null)[] {
  if (category === "pokemon") {
    // Pokemon Japan (85) searched before the main Pokemon category (3) for
    // a recognized Japanese card -- otherwise the loop's early
    // `candidates.size >= limit` break can fill up on English-catalog
    // near-misses before the Japanese-catalog printing is ever queried.
    return isJapaneseLanguage(language) ? [85, 3] : [3, 85];
  }
  if (category === "magic") return [1];
  if (category === "yugioh") return [2];
  return [null];
}

function isJapaneseLanguage(language: string): boolean {
  const value = language.trim().toLowerCase();
  return (
    value === "ja" ||
    value === "jpn" ||
    value.startsWith("ja-") ||
    value.startsWith("japan")
  );
}

function uniqueQueries(queries: readonly string[]): string[] {
  return [
    ...new Set(
      queries.map((query) => query.trim()).filter((query) => query.length >= 2),
    ),
  ].slice(0, 6);
}

/** Schema bounds `normalizeTcgcsvCandidate` truncates salvageable catalog
 * text into before validating (G4) -- kept in sync with
 * `CardLookupCandidateSchema`'s `name`/`game` limits in
 * `packages/domain/src/card-lookups.ts`. */
const MAX_CANDIDATE_NAME_LENGTH = 240;
const MAX_CANDIDATE_GAME_LENGTH = 120;

type NormalizedCandidateOutcome =
  | { ok: true; candidate: CardLookupCandidate }
  | { ok: false; reason?: "malformed" };

function normalizeTcgcsvCandidate(
  product: Record<string, unknown>,
  recognition: CardRecognition,
): NormalizedCandidateOutcome {
  const categoryId = positiveInteger(product.categoryId);
  const groupId = positiveInteger(product.groupId);
  const productId = positiveInteger(product.productId);
  if (!categoryId || !groupId || !productId) return { ok: false };
  const name = clampToLength(
    stringValue(product.name) ||
      stringValue(product.cleanName) ||
      `Product ${productId}`,
    MAX_CANDIDATE_NAME_LENGTH,
  );
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
  // `prices[0]` was ordering luck, not evidence: TCGCSV lists one price row
  // per printing (Normal, Holofoil, ...) with no documented canonical
  // order, so the first row was really an arbitrary one. Only report a
  // variant when every price row agrees on it; multiple distinct
  // subtypeNames mean multiple printings share this product listing, and
  // the collector -- not this heuristic -- picks the actual printing in
  // the client (G17).
  const distinctSubtypeNames = new Set(
    prices
      .map((price) => stringValue(price.subtypeName))
      .filter((subtypeName) => subtypeName.length > 0),
  );
  const variant =
    distinctSubtypeNames.size === 1 ? [...distinctSubtypeNames][0]! : "";
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
    game: clampToLength(
      categoryName(categoryId, stringValue(product.categoryName)),
      MAX_CANDIDATE_GAME_LENGTH,
    ),
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
  // A `safeParse` here (never the unguarded `parse` this replaced) is load
  // bearing: it keeps one malformed upstream catalog row from ever
  // surfacing as a client-facing `400` through the shared ZodError handler
  // (G4). After this point, no catalog data can reach that mapping --
  // salvageable text was already clamped to the schema's bounds above, and
  // anything still invalid is dropped with a warning instead of thrown.
  const parsed = CardLookupCandidateSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, candidate: parsed.data }
    : { ok: false, reason: "malformed" };
}

function clampToLength(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
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

/**
 * Unicode-aware token normalization for scoring/comparison (G8b): NFKC
 * folds compatibility variants (full-width digits/letters, for example)
 * into their standard form, then only Unicode letters (`\p{L}`, which
 * includes CJK/Kana as well as Latin) and numbers (`\p{N}`) survive.
 * Exported so `card-recognition-qualification.ts` can share this instead
 * of keeping its own copy (G3).
 */
export function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizedNumber(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ""));
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
  sizeErrorMessage = "The card catalog response exceeded its size limit",
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
        throw new Error(sizeErrorMessage);
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

/**
 * Combines a caller-supplied signal (typically tied to client disconnect)
 * with this call's own per-phase timeout, so either aborts the request.
 * `fetch` only accepts one `signal`, unlike the OpenAI SDK which merges a
 * passed-in signal with its own configured timeout itself.
 */
function combinedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

function validatedOllamaBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("The Ollama URL must use HTTP or HTTPS");
  }
  if (
    url.protocol === "http:" &&
    ![
      "localhost",
      "127.0.0.1",
      "[::1]",
      "host.docker.internal",
      "ollama",
    ].includes(url.hostname)
  ) {
    throw new Error("The Ollama URL must use HTTPS outside the local machine");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "The Ollama URL must be an origin without credentials, a path, query, or fragment",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function encodedCardImage(imageDataUrl: string): string {
  const match =
    /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      imageDataUrl,
    );
  if (!match?.[1]) throw new Error("The card image data URL is invalid");
  return match[1];
}

function recognitionInstruction(categoryHint: CardLookupCategory): string {
  return categoryHint === "all"
    ? "Recognize this card for catalog lookup."
    : `Recognize this card for ${categoryHint} catalog lookup. Treat the category as a user hint, not verified evidence.`;
}
