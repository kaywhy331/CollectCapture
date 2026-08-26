# CollectFolio card-lookup service

## Scope

CollectCapture exposes an optional, stateless `POST /v1/card-lookups` route for CollectFolio. CollectFolio remains responsible for camera/file input, browser-side boundary editing and crop re-encoding, suggestion review, exact-printing selection, and explicit confirmation. This endpoint performs recognition and authenticated lookup only; it does not create a CollectCapture item or mutate either application's database.

The route is absent unless its dedicated verifier and service are both configured. It never falls back to CollectCapture's main application token verifier.

## Configuration

Configure the shared boundary plus one recognition provider:

```text
COLLECTFOLIO_APP_URL=https://<exact-collectfolio-origin>
COLLECTFOLIO_SUPABASE_URL=https://<collectfolio-project>.supabase.co
COLLECTFOLIO_SUPABASE_JWKS_URL=             # optional custom discovery URL
COLLECTFOLIO_CATALOG_URL=https://<collectfolio-private-catalog-origin>
CARD_RECOGNITION_PROVIDER=openai|ollama|groq
OPENAI_API_KEY=<required only when provider=openai>
OPENAI_MODEL=<reviewed vision-capable model>
OLLAMA_BASE_URL=http://127.0.0.1:11434|https://ollama.com
OLLAMA_API_KEY=<required only for direct Ollama Cloud>
OLLAMA_MODEL=<reviewed vision-capable model>
GROQ_API_KEY=<required only when provider=groq>
GROQ_MODEL=qwen/qwen3.6-27b
```

The recommended standalone process needs only these values plus host, port, and log level; it does not need a database or unrelated CollectCapture production configuration. Its selected provider is fail-closed. The full API can still expose the same optional route with its existing production requirements and OpenAI configuration. `COLLECTFOLIO_APP_URL` is added to the exact CORS allowlist. `COLLECTFOLIO_SUPABASE_URL` defines the issuer and default asymmetric JWKS discovery URL; the optional override supports a reviewed custom or Docker-host discovery endpoint. `COLLECTFOLIO_CATALOG_URL` must use HTTPS outside loopback or `host.docker.internal`.

Standalone build, container, edge, scaling, qualification, and rollback instructions are in [the deployment runbook](deploy-card-lookups.md).

## Request and response

The endpoint requires `Authorization: Bearer <CollectFolio Supabase JWT>`, accepts at most 30 requests per principal per hour, and has a 3 MB HTTP body limit.

```json
{
  "imageDataUrl": "data:image/jpeg;base64,...",
  "query": "optional collector correction, at most 240 characters",
  "category": "all",
  "limit": 12
}
```

The decoded JPEG, PNG, or WebP must be at most 2 MiB and its declared type must match its bytes. The service computes the content SHA-256 before recognition. When `query` is empty, the configured OpenAI, Ollama, or Groq model produces conservative structured visible-text evidence; when it is present, provider recognition is skipped and the query becomes the evidence. Each bounded query is sent to the private CollectFolio `catalog/search` endpoint with the same bearer token.

The response is cache-disabled and has this shape:

```json
{
  "lookup": {
    "contentSha256": "<64 lowercase hex characters>",
    "imageRetained": false,
    "recognition": {},
    "candidates": [],
    "warnings": []
  }
}
```

Candidates contain identity metadata and an exact TCGCSV `(categoryId, groupId, productId)` tuple, but always have `matchBucket: "likely"`. Prices are null/absent by contract. Only CollectFolio's collector-driven selection and separate confirmation can promote one tuple to an approved holding.

## Privacy and resource limits

- CollectFolio sends a Canvas-reencoded crop, never the full source photo.
- This route does not persist the crop in PostgreSQL, Supabase Storage, filesystem storage, application cache, or domain records.
- Authorization and request bodies are redacted from structured logs. Do not add body logging or error telemetry containing the data URL.
- OpenAI Responses storage is disabled with `store: false`. Local Ollama inference remains on the configured host. Ollama Cloud and Groq process the crop under their account and provider data controls; provider selection therefore changes the external privacy boundary.
- OpenAI recognition is bounded to 15 seconds; standalone Groq defaults to 60 seconds and Ollama to 120 seconds. Direct Ollama/Groq HTTP responses are capped at 512 KiB. All catalog attempts share a 14-second deadline, each response is capped at 8 MiB, and the browser independently aborts after 30 seconds.
- The result's `imageRetained: false` field is a mandatory service assertion, not a claim that an external provider has zero retention.
- If the browser or an intermediate hop disconnects before a response is sent, the server cancels the in-flight provider and catalog calls immediately rather than continuing to spend time (and, for Ollama Cloud/Groq, provider cost) on a lookup nobody is waiting for.

### Deadline budget

| Layer                                             | Deadline                                               |
| ------------------------------------------------- | ------------------------------------------------------ |
| CollectFolio browser                              | 30 s                                                   |
| Cloudflare Tunnel edge (when deployed behind one) | ~100 s                                                 |
| Recognition provider                              | OpenAI 15 s · Groq 60 s default · Ollama 120 s default |
| Catalog search                                    | 14 s                                                   |

Each layer's deadline must comfortably exceed the one after it. The standalone service warns at startup if the selected provider's timeout plus the 14-second catalog budget would exceed the edge deadline; see [the deployment runbook](deploy-card-lookups.md) for the full table and the `GROQ_TIMEOUT_MS`/`OLLAMA_TIMEOUT_MS` knobs.

Any future persistence, asynchronous enrichment, broader image use, or provider outside the reviewed OpenAI/Ollama/Groq adapters requires a new contract version, privacy review, retention disclosure, and CollectFolio UI approval before rollout.

## Verification

```sh
pnpm run build:packages
pnpm --filter @localclear/api exec vitest run test/card-lookup-app.test.ts test/card-lookups.test.ts test/card-recognition-qualification.test.ts test/auth-config.test.ts --maxWorkers=1
pnpm --filter @localclear/api typecheck
pnpm test
pnpm typecheck
pnpm build
pnpm format:check
```

Production qualification must include valid and expired CollectFolio tokens, a token from the CollectCapture issuer, origin rejection, malformed and oversized images, manual-query provider bypass, provider/catalog outage, rate limiting, response-cache headers, log inspection, and confirmation that no crop appears in database or object storage.
