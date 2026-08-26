import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CardRecognitionSchema,
  type CardLookupCategory,
  type CardRecognition,
} from "@localclear/domain";
import { z } from "zod";
import { readCardLookupConfig } from "./card-lookup-config.js";
import {
  GroqCardRecognitionProvider,
  OllamaCardRecognitionProvider,
  OpenAICardRecognitionProvider,
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
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

type ExpectedRecognition = z.infer<typeof ExpectedRecognitionSchema>;

interface FieldCheck {
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

function usage(): string {
  return `Benchmark the configured CollectCapture vision provider.

Usage:
  node dist/card-recognition-qualification.js /qualification/manifest.json

The manifest is evaluated sequentially. Its image paths must be relative to the
manifest and remain inside the same mounted directory. No image is retained.`;
}

async function main(): Promise<number> {
  const argument = process.argv[2];
  if (!argument || argument === "--help" || argument === "-h") {
    console.log(usage());
    return argument ? 0 : 2;
  }
  if (process.argv.length > 3) throw new Error("Expected one manifest path");

  const manifestPath = resolve(argument);
  const manifestDirectory = resolve(manifestPath, "..");
  const manifest = QualificationManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const provider = configuredProvider();
  let passedChecks = 0;
  let totalChecks = 0;
  let totalDurationMs = 0;
  const durationsMs: number[] = [];

  console.log(
    `Benchmarking ${provider.providerName}/${provider.model} with ${manifest.cases.length} card(s)...`,
  );
  for (const benchmarkCase of manifest.cases) {
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
    try {
      const recognition = CardRecognitionSchema.parse(
        await provider.recognize({
          imageDataUrl,
          categoryHint: benchmarkCase.category as CardLookupCategory,
        }),
      );
      const durationMs = performance.now() - startedAt;
      totalDurationMs += durationMs;
      durationsMs.push(durationMs);
      const checks = compareRecognition(recognition, benchmarkCase.expected);
      const casePassed = checks.filter((check) => check.passed).length;
      passedChecks += casePassed;
      totalChecks += checks.length;
      console.log(
        `${casePassed === checks.length ? "PASS" : "FAIL"} ${benchmarkCase.id}: ${casePassed}/${checks.length} fields (${Math.round(durationMs)} ms)`,
      );
      for (const check of checks.filter((candidate) => !candidate.passed)) {
        console.log(
          `  ${check.field}: expected ${check.expected}; received ${check.actual}`,
        );
      }
    } catch (error) {
      const expectedChecks = expectedCheckCount(benchmarkCase.expected);
      totalChecks += expectedChecks;
      const durationMs = performance.now() - startedAt;
      totalDurationMs += durationMs;
      durationsMs.push(durationMs);
      console.log(
        `FAIL ${benchmarkCase.id}: ${error instanceof Error ? error.message : "recognition request failed"}`,
      );
    }
  }

  const passRate = totalChecks === 0 ? 0 : passedChecks / totalChecks;
  const averageDurationMs = totalDurationMs / manifest.cases.length;
  const sortedDurations = durationsMs.toSorted((left, right) => left - right);
  const p95DurationMs =
    sortedDurations[
      Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1)
    ] ?? 0;
  const qualified = passRate >= manifest.minimumPassRate;
  console.log(
    `${qualified ? "PASS" : "FAIL"} overall: ${passedChecks}/${totalChecks} fields (${(passRate * 100).toFixed(1)}%), threshold ${(manifest.minimumPassRate * 100).toFixed(1)}%, average ${Math.round(averageDurationMs)} ms/card, p95 ${Math.round(p95DurationMs)} ms/card`,
  );
  return qualified ? 0 : 1;
}

function configuredProvider(): CardRecognitionProvider {
  const config = readCardLookupConfig();
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
