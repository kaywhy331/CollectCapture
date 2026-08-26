import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CardRecognitionSchema,
  type CardLookupCandidate,
  type CardLookupCategory,
  type CardRecognition,
} from "@localclear/domain";
import { z } from "zod";
import {
  readCardLookupConfig,
  type CardLookupConfig,
} from "./card-lookup-config.js";
import {
  GroqCardRecognitionProvider,
  normalized,
  normalizedNumber,
  OllamaCardRecognitionProvider,
  OpenAICardRecognitionProvider,
  StatelessCardLookupService,
  TcgcsvCardCatalogProvider,
  type CardRecognitionProvider,
} from "./card-lookups.js";

const ExpectedRecognitionSchema = z
  .object({
    category: z.enum(["pokemon", "magic", "yugioh", "other"]).optional(),
    name: z.string().trim().min(1).nullable().optional(),
    setName: z.string().trim().min(1).nullable().optional(),
    collectorNumber: z.string().trim().min(1).nullable().optional(),
    language: z.string().trim().min(2).optional(),
    visibleText: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Each case must define at least one expected recognition field",
  });

/**
 * Describes the one catalog product a `--catalog` run must find within its
 * top `topN` results (G3b). At least one of `productId`/`name` is required
 * so a match target actually exists; `productId` -- the exact TCGCSV
 * `(categoryId, groupId, productId)` tuple's last component -- is the most
 * reliable identifier when known.
 */
const ExpectedCatalogSchema = z
  .object({
    productId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).optional(),
    setName: z.string().trim().min(1).optional(),
    collectorNumber: z.string().trim().min(1).optional(),
    topN: z.number().int().min(1).max(24).default(5),
  })
  .strict()
  .refine(
    (value) => value.productId !== undefined || value.name !== undefined,
    {
      message: "expectedCatalog must specify at least productId or name",
    },
  );

const QualificationManifestSchema = z
  .object({
    minimumPassRate: z.number().min(0).max(1).default(0.9),
    cases: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            image: z.string().trim().min(1),
            category: z
              .enum(["all", "pokemon", "magic", "yugioh", "other"])
              .default("all"),
            expected: ExpectedRecognitionSchema,
            expectedCatalog: ExpectedCatalogSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export type ExpectedRecognition = z.infer<typeof ExpectedRecognitionSchema>;
export type ExpectedCatalog = z.infer<typeof ExpectedCatalogSchema>;

export interface FieldCheck {
  field: string;
  passed: boolean;
  expected: string;
  actual: string;
}

export function compareRecognition(
  recognition: CardRecognition,
  expected: ExpectedRecognition,
): FieldCheck[] {
  const checks: FieldCheck[] = [];
  for (const field of [
    "category",
    "name",
    "setName",
    "collectorNumber",
    "language",
  ] as const) {
    if (!Object.hasOwn(expected, field)) continue;
    const expectedValue = expected[field] ?? null;
    const actualValue = recognition[field] ?? null;
    checks.push({
      field,
      passed:
        expectedValue === null
          ? actualValue === null
          : field === "collectorNumber"
            ? normalizedNumber(String(actualValue ?? "")) ===
              normalizedNumber(expectedValue)
            : normalized(String(actualValue ?? "")) ===
              normalized(expectedValue),
      expected: displayValue(expectedValue),
      actual: displayValue(actualValue),
    });
  }

  const recognizedText = normalized(recognition.visibleText.join(" "));
  for (const expectedText of expected.visibleText ?? []) {
    checks.push({
      field: "visibleText",
      passed: recognizedText.includes(normalized(expectedText)),
      expected: expectedText,
      actual: recognition.visibleText.join(" | ") || "<empty>",
    });
  }
  return checks;
}

/**
 * Whether `candidate` is the product an `expectedCatalog` block describes
 * (G3b). `productId`, when given, is decisive on its own -- it is the
 * exact TCGCSV identifier. Otherwise every declared field (`name` is
 * required by the schema; `setName`/`collectorNumber` are additional
 * constraints when present) must match.
 */
export function matchesExpectedCatalog(
  candidate: CardLookupCandidate,
  expected: ExpectedCatalog,
): boolean {
  if (expected.productId !== undefined) {
    return candidate.productId === expected.productId;
  }
  if (
    expected.name !== undefined &&
    normalized(candidate.name) !== normalized(expected.name)
  ) {
    return false;
  }
  if (
    expected.setName !== undefined &&
    normalized(candidate.setName) !== normalized(expected.setName)
  ) {
    return false;
  }
  if (
    expected.collectorNumber !== undefined &&
    normalizedNumber(candidate.number) !==
      normalizedNumber(expected.collectorNumber)
  ) {
    return false;
  }
  return true;
}

function usage(): string {
  return `Benchmark the configured CollectCapture vision provider.

Usage:
  node dist/card-recognition-qualification.js /qualification/manifest.json
  node dist/card-recognition-qualification.js /qualification/manifest.json --catalog [--token <bearer-token>]

The manifest is evaluated sequentially. Its image paths must be relative to the
manifest and remain inside the same mounted directory. No image is retained.

--catalog additionally runs the real catalog search (against the configured
COLLECTFOLIO_CATALOG_URL) for every case that declares an "expectedCatalog"
block, and passes that case only if the expected product appears in the
top N results. It requires a bearer token, via --token or the
CARD_LOOKUP_QUALIFICATION_TOKEN environment variable.`;
}

interface ParsedArguments {
  manifestPath: string;
  catalogMode: boolean;
  token: string | undefined;
}

function parseArguments(argv: string[]): ParsedArguments {
  let manifestPath: string | undefined;
  let catalogMode = false;
  let token: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--catalog") {
      catalogMode = true;
    } else if (argument === "--token") {
      index += 1;
      token = argv[index];
      if (token === undefined) {
        throw new Error("--token requires a value");
      }
    } else if (!argument.startsWith("--") && manifestPath === undefined) {
      manifestPath = argument;
    } else {
      throw new Error(`Unrecognized argument: ${argument}`);
    }
  }
  if (!manifestPath) throw new Error("Expected a manifest path");
  return {
    manifestPath,
    catalogMode,
    token: token ?? process.env.CARD_LOOKUP_QUALIFICATION_TOKEN,
  };
}

export interface CaseOutcome {
  id: string;
  category: CardLookupCategory | "all";
  language: string;
  checks: FieldCheck[];
}

export interface CategoryAggregate {
  passedChecks: number;
  totalChecks: number;
  caseCount: number;
  casesPassed: number;
}

export interface QualificationEvaluation {
  passedChecks: number;
  totalChecks: number;
  passRate: number;
  categoryAggregates: Map<string, CategoryAggregate>;
  languageAggregates: Map<string, CategoryAggregate>;
  failingCategories: string[];
  qualified: boolean;
}

/**
 * Aggregates every case's checks overall, by game category, and by
 * language (G3c). Qualification requires the overall pass rate to meet
 * `minimumPassRate` AND every individual game category's own pass rate to
 * meet it too -- a category with few cases can otherwise hide behind a
 * majority category's good results, which the blended overall rate alone
 * would mask. The per-language breakdown is reported but not itself
 * gated.
 */
export function evaluateQualification(
  outcomes: CaseOutcome[],
  minimumPassRate: number,
): QualificationEvaluation {
  const categoryAggregates = aggregateBy(
    outcomes,
    (outcome) => outcome.category,
  );
  const languageAggregates = aggregateBy(
    outcomes,
    (outcome) => outcome.language,
  );
  const passedChecks = outcomes.reduce(
    (sum, outcome) =>
      sum + outcome.checks.filter((check) => check.passed).length,
    0,
  );
  const totalChecks = outcomes.reduce(
    (sum, outcome) => sum + outcome.checks.length,
    0,
  );
  const passRate = totalChecks === 0 ? 0 : passedChecks / totalChecks;
  const failingCategories = [...categoryAggregates.entries()]
    .filter(([, aggregate]) => passRateOf(aggregate) < minimumPassRate)
    .map(([category]) => category);
  return {
    passedChecks,
    totalChecks,
    passRate,
    categoryAggregates,
    languageAggregates,
    failingCategories,
    qualified: passRate >= minimumPassRate && failingCategories.length === 0,
  };
}

export interface LatencySummary {
  sampledDurationsMs: number[];
  averageMs: number;
  p95Ms: number;
}

/**
 * Excludes the first entry -- the warm-up case's cold-start latency (model
 * load, connection setup) that every later case skips -- from the
 * average/p95 computation (G3d). The warm-up case still counts fully
 * toward pass/fail via {@link evaluateQualification}, which never sees
 * this function's output; only reported latency is affected.
 */
export function summarizeLatency(
  durationsMsInCaseOrder: number[],
): LatencySummary {
  const sampledDurationsMs = durationsMsInCaseOrder.slice(1);
  const averageMs =
    sampledDurationsMs.length === 0
      ? 0
      : sampledDurationsMs.reduce((sum, value) => sum + value, 0) /
        sampledDurationsMs.length;
  const sorted = sampledDurationsMs.toSorted((left, right) => left - right);
  const p95Ms = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  return { sampledDurationsMs, averageMs, p95Ms };
}

async function main(): Promise<number> {
  if (process.argv.length <= 2 || ["--help", "-h"].includes(process.argv[2]!)) {
    console.log(usage());
    return process.argv.length <= 2 ? 2 : 0;
  }

  const {
    manifestPath: manifestArgument,
    catalogMode,
    token,
  } = parseArguments(process.argv.slice(2));
  const manifestPath = resolve(manifestArgument);
  const manifestDirectory = resolve(manifestPath, "..");
  const manifest = QualificationManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );

  const config = readCardLookupConfig();
  const provider = configuredProvider(config);
  const catalogProvider = catalogMode
    ? buildQualificationCatalogProvider(config, token)
    : undefined;
  const service = catalogProvider
    ? new StatelessCardLookupService(provider, catalogProvider)
    : undefined;

  const durationsMs: number[] = [];
  const outcomes: CaseOutcome[] = [];

  console.log(
    `Benchmarking ${provider.providerName}/${provider.model} with ${manifest.cases.length} card(s)${catalogMode ? " (catalog-aware)" : ""}...`,
  );
  for (let index = 0; index < manifest.cases.length; index += 1) {
    const benchmarkCase = manifest.cases[index]!;
    const imagePath = resolve(manifestDirectory, benchmarkCase.image);
    const relativeImagePath = relative(manifestDirectory, imagePath);
    if (
      isAbsolute(benchmarkCase.image) ||
      relativeImagePath === ".." ||
      relativeImagePath.startsWith(
        `..${process.platform === "win32" ? "\\" : "/"}`,
      )
    ) {
      throw new Error(
        `Case ${benchmarkCase.id} points outside the qualification directory`,
      );
    }
    const imageDataUrl = await imageFileDataUrl(imagePath);
    const startedAt = performance.now();
    let recognition: CardRecognition | undefined;
    let checks: FieldCheck[] = [];
    try {
      if (service && benchmarkCase.expectedCatalog) {
        const lookup = await service.lookup(
          {
            imageDataUrl,
            query: "",
            category: benchmarkCase.category,
            limit: benchmarkCase.expectedCatalog.topN,
          },
          { authorization: `Bearer ${token}` },
        );
        recognition = lookup.recognition;
        checks = compareRecognition(recognition, benchmarkCase.expected);
        checks.push(
          catalogMatchCheck(lookup.candidates, benchmarkCase.expectedCatalog),
        );
      } else {
        recognition = CardRecognitionSchema.parse(
          await provider.recognize({
            imageDataUrl,
            categoryHint: benchmarkCase.category,
          }),
        );
        checks = compareRecognition(recognition, benchmarkCase.expected);
      }
      const casePassed = checks.filter((check) => check.passed).length;
      const durationMs = performance.now() - startedAt;
      durationsMs.push(durationMs);
      console.log(
        `${casePassed === checks.length ? "PASS" : "FAIL"} ${benchmarkCase.id}: ${casePassed}/${checks.length} fields (${Math.round(durationMs)} ms)`,
      );
      for (const check of checks.filter((candidate) => !candidate.passed)) {
        console.log(
          `  ${check.field}: expected ${check.expected}; received ${check.actual}`,
        );
      }
    } catch (error) {
      const expectedChecks =
        expectedCheckCount(benchmarkCase.expected) +
        (benchmarkCase.expectedCatalog ? 1 : 0);
      // A failed attempt still occupies a duration sample and counts
      // every expected field as failed, so it is not silently dropped
      // from either the latency or pass-rate accounting.
      checks = Array.from(
        { length: expectedChecks },
        (_unused, checkIndex) => ({
          field: `attempt-${checkIndex}`,
          passed: false,
          expected: "<recognition to succeed>",
          actual:
            error instanceof Error
              ? error.message
              : "recognition request failed",
        }),
      );
      durationsMs.push(performance.now() - startedAt);
      console.log(
        `FAIL ${benchmarkCase.id}: ${error instanceof Error ? error.message : "recognition request failed"}`,
      );
    }
    outcomes.push({
      id: benchmarkCase.id,
      category: benchmarkCase.category,
      language: benchmarkCase.expected.language ?? "unspecified",
      checks,
    });
  }

  const evaluation = evaluateQualification(outcomes, manifest.minimumPassRate);
  const latency = summarizeLatency(durationsMs);

  console.log("\nPer-category results:");
  for (const [category, aggregate] of evaluation.categoryAggregates) {
    const categoryFailed = evaluation.failingCategories.includes(category);
    console.log(
      `  ${category}: ${aggregate.passedChecks}/${aggregate.totalChecks} fields (${(passRateOf(aggregate) * 100).toFixed(1)}%), ${aggregate.casesPassed}/${aggregate.caseCount} cases passed${categoryFailed ? ` -> FAIL (threshold ${(manifest.minimumPassRate * 100).toFixed(1)}%)` : ""}`,
    );
  }
  console.log("\nPer-language results:");
  for (const [language, aggregate] of evaluation.languageAggregates) {
    console.log(
      `  ${language}: ${aggregate.passedChecks}/${aggregate.totalChecks} fields (${(passRateOf(aggregate) * 100).toFixed(1)}%), ${aggregate.casesPassed}/${aggregate.caseCount} cases passed`,
    );
  }

  console.log(
    `\n${evaluation.qualified ? "PASS" : "FAIL"} overall: ${evaluation.passedChecks}/${evaluation.totalChecks} fields (${(evaluation.passRate * 100).toFixed(1)}%), threshold ${(manifest.minimumPassRate * 100).toFixed(1)}%, average ${Math.round(latency.averageMs)} ms/card, p95 ${Math.round(latency.p95Ms)} ms/card`,
  );
  if (evaluation.failingCategories.length > 0) {
    console.log(
      `FAIL: categor${evaluation.failingCategories.length === 1 ? "y" : "ies"} below threshold: ${evaluation.failingCategories.join(", ")}`,
    );
  }
  return evaluation.qualified ? 0 : 1;
}

function aggregateBy(
  outcomes: CaseOutcome[],
  key: (outcome: CaseOutcome) => string,
): Map<string, CategoryAggregate> {
  const aggregates = new Map<string, CategoryAggregate>();
  for (const outcome of outcomes) {
    const bucketKey = key(outcome);
    const aggregate = aggregates.get(bucketKey) ?? {
      passedChecks: 0,
      totalChecks: 0,
      caseCount: 0,
      casesPassed: 0,
    };
    const casePassedChecks = outcome.checks.filter(
      (check) => check.passed,
    ).length;
    aggregate.passedChecks += casePassedChecks;
    aggregate.totalChecks += outcome.checks.length;
    aggregate.caseCount += 1;
    if (
      casePassedChecks === outcome.checks.length &&
      outcome.checks.length > 0
    ) {
      aggregate.casesPassed += 1;
    }
    aggregates.set(bucketKey, aggregate);
  }
  return aggregates;
}

function passRateOf(aggregate: CategoryAggregate): number {
  return aggregate.totalChecks === 0
    ? 0
    : aggregate.passedChecks / aggregate.totalChecks;
}

function catalogMatchDescription(expected: ExpectedCatalog): string {
  if (expected.productId !== undefined)
    return `productId ${expected.productId}`;
  const parts = [
    expected.name,
    expected.setName,
    expected.collectorNumber,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" / ");
}

/**
 * Builds the `catalogMatch` check a `--catalog` case's real search results
 * either satisfy or don't (G3b) -- factored out of `main` so the pass/fail
 * decision is testable against a fabricated candidate list, without
 * running a real catalog search.
 */
export function catalogMatchCheck(
  candidates: CardLookupCandidate[],
  expected: ExpectedCatalog,
): FieldCheck {
  const found = candidates.some((candidateItem) =>
    matchesExpectedCatalog(candidateItem, expected),
  );
  return {
    field: "catalogMatch",
    passed: found,
    expected: catalogMatchDescription(expected),
    actual: `${candidates.length} candidate(s): ${candidates.map((candidateItem) => candidateItem.name).join(", ") || "<none>"}`,
  };
}

function buildQualificationCatalogProvider(
  config: CardLookupConfig,
  token: string | undefined,
): TcgcsvCardCatalogProvider {
  if (!config.COLLECTFOLIO_CATALOG_URL || !token) {
    throw new Error(
      "--catalog requires COLLECTFOLIO_CATALOG_URL to be configured and a bearer token via --token or CARD_LOOKUP_QUALIFICATION_TOKEN",
    );
  }
  return new TcgcsvCardCatalogProvider({
    baseUrl: config.COLLECTFOLIO_CATALOG_URL,
  });
}

function configuredProvider(config: CardLookupConfig): CardRecognitionProvider {
  if (config.CARD_RECOGNITION_PROVIDER === "ollama") {
    return new OllamaCardRecognitionProvider({
      baseUrl: config.OLLAMA_BASE_URL,
      ...(config.OLLAMA_API_KEY ? { apiKey: config.OLLAMA_API_KEY } : {}),
      model: config.OLLAMA_MODEL,
      timeoutMs: config.OLLAMA_TIMEOUT_MS,
    });
  }
  if (config.CARD_RECOGNITION_PROVIDER === "groq") {
    return new GroqCardRecognitionProvider({
      apiKey: config.GROQ_API_KEY!,
      model: config.GROQ_MODEL,
      timeoutMs: config.GROQ_TIMEOUT_MS,
      reasoningEffort: config.GROQ_REASONING_EFFORT,
      responseFormat: config.GROQ_RESPONSE_FORMAT,
      maxCompletionTokens: config.GROQ_MAX_COMPLETION_TOKENS,
    });
  }
  return new OpenAICardRecognitionProvider({
    apiKey: config.OPENAI_API_KEY!,
    model: config.OPENAI_MODEL,
  });
}

async function imageFileDataUrl(path: string): Promise<string> {
  const extension = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase();
  const mediaType =
    extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : extension === "png"
        ? "image/png"
        : extension === "webp"
          ? "image/webp"
          : null;
  if (!mediaType) {
    throw new Error(`Unsupported image extension for ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > 2 * 1024 * 1024) {
    throw new Error(`Image exceeds the 2 MiB lookup limit: ${path}`);
  }
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

function expectedCheckCount(expected: ExpectedRecognition): number {
  return (
    ["category", "name", "setName", "collectorNumber", "language"].filter(
      (field) => Object.hasOwn(expected, field),
    ).length + (expected.visibleText?.length ?? 0)
  );
}

function displayValue(value: string | null): string {
  return value === null ? "<null>" : JSON.stringify(value);
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntryPoint) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
