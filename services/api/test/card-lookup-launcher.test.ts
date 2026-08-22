import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const launcher = join(repositoryRoot, "scripts/launch-card-lookups.mjs");
const redPcLauncher = join(repositoryRoot, "scripts/red-pc-card-lookups.ps1");
const requiredVariables = [
  "CARD_RECOGNITION_PROVIDER",
  "OPENAI_API_KEY",
  "OLLAMA_API_KEY",
  "GROQ_API_KEY",
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
  it("defines the RED PC cloud, CPU, NVIDIA, and qualification paths", () => {
    const powerShell = readFileSync(redPcLauncher, "utf8");
    const baseCompose = readFileSync(
      join(repositoryRoot, "compose.card-lookups.yml"),
      "utf8",
    );
    const localCompose = readFileSync(
      join(repositoryRoot, "compose.card-lookups.ollama-local.yml"),
      "utf8",
    );
    const nvidiaCompose = readFileSync(
      join(repositoryRoot, "compose.card-lookups.nvidia.yml"),
      "utf8",
    );

    expect(powerShell).toContain(
      '[ValidateSet("Groq", "OllamaCloud", "OllamaLocal")]',
    );
    expect(powerShell).toContain('"Qualify"');
    expect(baseCompose).toContain("${COLLECTCAPTURE_BIND_ADDRESS:-127.0.0.1}");
    expect(localCompose).toContain("condition: service_completed_successfully");
    expect(localCompose).toContain("ollama pull");
    expect(nvidiaCompose).toContain("gpus: all");
  });

  it("defines an opt-in, token-based Cloudflare Tunnel path", () => {
    const powerShell = readFileSync(redPcLauncher, "utf8");
    const tunnelCompose = readFileSync(
      join(repositoryRoot, "compose.card-lookups.tunnel.yml"),
      "utf8",
    );
    const environmentTemplate = readFileSync(
      join(repositoryRoot, ".env.card-lookups.red-pc.example"),
      "utf8",
    );
    const tunnelGuide = readFileSync(
      join(repositoryRoot, "docs/red-pc-cloudflare-tunnel.md"),
      "utf8",
    );

    expect(powerShell).toContain("[switch]$Tunnel");
    expect(powerShell).toContain('"CLOUDFLARE_TUNNEL_HOSTNAME"');
    expect(powerShell).toContain('"CLOUDFLARE_TUNNEL_TOKEN"');
    expect(powerShell).toContain('$arguments += @("-f", $TunnelComposeFile)');
    expect(tunnelCompose).toContain("cloudflare/cloudflared:2026.8.2");
    expect(tunnelCompose).toContain("TUNNEL_TOKEN:");
    expect(tunnelCompose).toContain("${CLOUDFLARE_TUNNEL_TOKEN:?");
    expect(tunnelCompose).not.toContain("--token");
    expect(tunnelCompose).not.toContain("ports:");
    expect(environmentTemplate).toContain("CLOUDFLARE_TUNNEL_HOSTNAME=");
    expect(environmentTemplate).toContain("CLOUDFLARE_TUNNEL_TOKEN=");
    expect(tunnelGuide).toContain("http://card-lookups:4100");
    expect(tunnelGuide).toContain("No router port-forward");
  });

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

  it("requires the selected cloud provider key instead of an OpenAI key", () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "collectcapture-card-lookup-launcher-"),
    );
    const environmentFile = join(temporaryDirectory, "groq.env");
    writeFileSync(
      environmentFile,
      [
        "CARD_RECOGNITION_PROVIDER=groq",
        "COLLECTFOLIO_APP_URL=https://folio.example.test",
        "COLLECTFOLIO_SUPABASE_URL=https://folio-project.example.test",
        "COLLECTFOLIO_CATALOG_URL=https://catalog.example.test",
      ].join("\n"),
    );
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
      expect(result.stderr).toContain("GROQ_API_KEY");
      expect(result.stderr).not.toContain("OPENAI_API_KEY");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
