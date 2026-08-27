#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultEnvironmentFile = resolve(
  repositoryRoot,
  ".env.card-lookups.local",
);
const sharedRequiredVariables = [
  "COLLECTFOLIO_APP_URL",
  "COLLECTFOLIO_SUPABASE_URL",
  "COLLECTFOLIO_CATALOG_URL",
];
const providerSecret = {
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
};

let activeChild;
let shutdownSignal;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdownSignal = signal;
    const childToStop = activeChild;
    setTimeout(() => {
      if (activeChild === childToStop) childToStop?.kill(signal);
    }, 100).unref();
  });
}

function usage() {
  return `Launch the standalone CollectCapture card-lookup API.

Usage:
  pnpm launch:card-lookups
  pnpm launch:card-lookups -- --watch
  pnpm launch:card-lookups -- --env-file /secure/path/card-lookups.env

Options:
  --watch            Rebuild workspace packages, then run the TypeScript server in watch mode.
  --env-file <path>  Load a specific environment file instead of .env.card-lookups.local.
  --help              Show this help.

Exported environment variables take precedence over values loaded from the file.`;
}

function parseArguments(arguments_) {
  let environmentFile = defaultEnvironmentFile;
  let environmentFileWasExplicit = false;
  let watch = false;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--watch") {
      watch = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--env-file") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--env-file requires a path");
      environmentFile = resolve(repositoryRoot, value);
      environmentFileWasExplicit = true;
      index += 1;
    } else if (argument?.startsWith("--env-file=")) {
      const value = argument.slice("--env-file=".length);
      if (!value) throw new Error("--env-file requires a path");
      environmentFile = resolve(repositoryRoot, value);
      environmentFileWasExplicit = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { environmentFile, environmentFileWasExplicit, help, watch };
}

function run(command, arguments_) {
  return new Promise((resolveExitCode) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", (error) => {
      console.error(`Unable to start ${command}: ${error.message}`);
      activeChild = undefined;
      resolveExitCode(1);
    });
    child.once("exit", (code, signal) => {
      activeChild = undefined;
      if (shutdownSignal) {
        resolveExitCode(0);
        return;
      }
      if (typeof code === "number") {
        resolveExitCode(code);
      } else {
        resolveExitCode(signal === "SIGINT" ? 130 : 1);
      }
    });
  });
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run with --help for usage.");
    return 1;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (existsSync(options.environmentFile)) {
    try {
      loadEnvFile(options.environmentFile);
      console.log(`Loaded ${options.environmentFile}`);
    } catch (error) {
      console.error(
        `Unable to load ${options.environmentFile}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 1;
    }
  } else if (options.environmentFileWasExplicit) {
    console.error(`Environment file was not found: ${options.environmentFile}`);
    return 1;
  }

  const provider = process.env.CARD_RECOGNITION_PROVIDER?.trim() || "openai";
  if (!["openai", "ollama", "groq"].includes(provider)) {
    console.error(`Unsupported CARD_RECOGNITION_PROVIDER: ${provider}`);
    return 1;
  }
  const ollamaCloudKey =
    provider === "ollama" &&
    (() => {
      try {
        return (
          new URL(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434")
            .hostname === "ollama.com"
        );
      } catch {
        return false;
      }
    })()
      ? "OLLAMA_API_KEY"
      : undefined;
  const requiredVariables = [
    ...sharedRequiredVariables,
    ...(providerSecret[provider] ? [providerSecret[provider]] : []),
    ...(ollamaCloudKey ? [ollamaCloudKey] : []),
  ];
  const missing = requiredVariables.filter(
    (name) => !process.env[name]?.trim(),
  );
  if (missing.length > 0) {
    console.error(`Missing required configuration: ${missing.join(", ")}`);
    console.error(
      "Copy .env.card-lookups.example to .env.card-lookups.local, fill in the values, and run the launcher again.",
    );
    return 1;
  }

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  console.log("Building shared workspace packages...");
  const packageBuild = await run(pnpm, ["run", "build:packages"]);
  if (shutdownSignal) return 0;
  if (packageBuild !== 0) return packageBuild;

  if (options.watch) {
    console.log("Starting the card-lookup API in watch mode...");
    return run(pnpm, [
      "--filter",
      "@localclear/api",
      "exec",
      "tsx",
      "watch",
      "src/card-lookup-server.ts",
    ]);
  }

  console.log("Building the card-lookup API...");
  const apiBuild = await run(pnpm, ["--filter", "@localclear/api", "build"]);
  if (shutdownSignal) return 0;
  if (apiBuild !== 0) return apiBuild;

  console.log("Starting the card-lookup API...");
  return run(process.execPath, [
    resolve(repositoryRoot, "services/api/dist/card-lookup-server.js"),
  ]);
}

process.exitCode = await main();
