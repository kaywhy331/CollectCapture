import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

if (!isMainThread) {
  const dependency = createRequire(import.meta.url)(workerData.packagePath);
  const imageSize = dependency.imageSize ?? dependency.default ?? dependency;

  try {
    const result = imageSize(Uint8Array.from(workerData.payload));
    parentPort.postMessage({ outcome: "returned", result });
  } catch (error) {
    parentPort.postMessage({
      outcome: "threw",
      error: error instanceof Error ? error.message : String(error),
    });
  }
} else {
  const virtualStore = join(repositoryRoot, "node_modules", ".pnpm");
  const lockfile = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const patchHash = lockfile.match(
    /patchedDependencies:\n\s+image-size@1\.2\.1:\s+([a-f0-9]{64})/,
  )?.[1];

  if (!patchHash) {
    throw new Error(
      "pnpm-lock.yaml does not record the image-size@1.2.1 patch",
    );
  }

  const packagePrefix = "image-size@1.2.1";
  const packagePaths = readdirSync(virtualStore)
    .filter(
      (entry) =>
        entry.startsWith(packagePrefix) &&
        entry.includes(`patch_hash=${patchHash}`),
    )
    .map((entry) => join(virtualStore, entry, "node_modules", "image-size"));

  if (packagePaths.length === 0) {
    throw new Error(
      "image-size@1.2.1 is not installed in the pnpm virtual store",
    );
  }

  const maliciousPayloads = {
    icns: [
      0x69, 0x63, 0x6e, 0x73, 0x00, 0x00, 0x00, 0x10, 0x69, 0x73, 0x33, 0x32,
      0x00, 0x00, 0x00, 0x00,
    ],
    jxl: [
      0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
      0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x6a, 0x78, 0x6c, 0x20,
      0x00, 0x00, 0x00, 0x00, 0x6a, 0x78, 0x6c, 0x20, 0x00, 0x00, 0x00, 0x00,
      0x6a, 0x78, 0x6c, 0x70, 0x00, 0x00, 0x00, 0x00,
    ],
    heif: [
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x24, 0x6d, 0x65, 0x74, 0x61,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x69, 0x70, 0x72, 0x70,
      0x00, 0x00, 0x00, 0x14, 0x69, 0x70, 0x63, 0x6f, 0x00, 0x00, 0x00, 0x00,
      0x69, 0x73, 0x70, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ],
  };

  const validPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    "base64",
  );

  async function executeWithTimeout(packagePath, payload, label) {
    return await new Promise((resolvePromise, rejectPromise) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { packagePath, payload },
      });
      const timeout = setTimeout(async () => {
        await worker.terminate();
        rejectPromise(
          new Error(`${label} parser did not settle within 2 seconds`),
        );
      }, 2_000);

      worker.once("message", (message) => {
        clearTimeout(timeout);
        resolvePromise(message);
      });
      worker.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
    });
  }

  for (const packagePath of packagePaths) {
    const manifest = JSON.parse(
      readFileSync(join(packagePath, "package.json"), "utf8"),
    );
    if (manifest.version !== "1.2.1") {
      throw new Error(`Unexpected image-size version: ${manifest.version}`);
    }

    for (const [label, payload] of Object.entries(maliciousPayloads)) {
      await executeWithTimeout(packagePath, payload, label);
    }

    const validResult = await executeWithTimeout(packagePath, validPng, "PNG");
    if (
      validResult.outcome !== "returned" ||
      validResult.result?.width !== 1 ||
      validResult.result?.height !== 1
    ) {
      throw new Error(`Patched image-size rejected a valid 1x1 PNG`);
    }
  }

  console.log(
    `Verified ${packagePaths.length} patched image-size@1.2.1 installation(s) against ICNS, JXL, and HEIF denial-of-service payloads.`,
  );
}
