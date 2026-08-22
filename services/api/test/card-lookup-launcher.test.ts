import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const launcher = join(repositoryRoot, "scripts/launch-card-lookups.mjs");
const requiredVariables = [
  "OPENAI_API_KEY",
  "COLLECTFOLIO_APP_URL",
  "COLLECTFOLIO_SUPABASE_URL",
  "COLLECTFOLIO_CATALOG_URL",
];

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of requiredVariables) delete environment[name];
  return environment;
}

describe("card lookup launcher", () => {
  it("documents the one-command and watch-mode entry points", () => {
    const result = spawnSync(process.execPath, [launcher, "--help"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: sanitizedEnvironment(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pnpm launch:card-lookups");
    expect(result.stdout).toContain("--watch");
  });

  it("fails fast with setup instructions when configuration is missing", () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "collectcapture-card-lookup-launcher-"),
    );
    const environmentFile = join(temporaryDirectory, "empty.env");
    writeFileSync(environmentFile, "");
    try {
      const result = spawnSync(
        process.execPath,
        [launcher, "--env-file", environmentFile],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: sanitizedEnvironment(),
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Missing required configuration");
      expect(result.stderr).toContain(".env.card-lookups.example");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
