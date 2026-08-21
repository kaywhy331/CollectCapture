# CollectFolio card-lookup service

## Scope

CollectCapture exposes an optional, stateless `POST /v1/card-lookups` route for CollectFolio. CollectFolio remains responsible for camera/file input, browser-side boundary editing and crop re-encoding, suggestion review, exact-printing selection, and explicit confirmation. This endpoint performs recognition and authenticated lookup only; it does not create a CollectCapture item or mutate either application's database.

The route is absent unless its dedicated verifier and service are both configured. It never falls back to CollectCapture's main application token verifier.

## Configuration

Configure the following as one group:

```text
COLLECTFOLIO_APP_URL=https://<exact-collectfolio-origin>
COLLECTFOLIO_SUPABASE_URL=https://<collectfolio-project>.supabase.co
COLLECTFOLIO_SUPABASE_JWKS_URL=             # optional custom discovery URL
COLLECTFOLIO_CATALOG_URL=https://<collectfolio-private-catalog-origin>
OPENAI_API_KEY=<server-only secret>
OPENAI_MODEL=<reviewed vision-capable model>
```

Partial integration configuration is rejected at startup. `COLLECTFOLIO_APP_URL` is added to the exact CORS allowlist. `COLLECTFOLIO_SUPABASE_URL` defines the issuer and default asymmetric JWKS discovery URL; the optional override is useful only for a reviewed custom discovery endpoint. `COLLECTFOLIO_CATALOG_URL` must use HTTPS outside localhost. Existing CollectCapture production configuration requirements continue to apply.

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

The decoded JPEG, PNG, or WebP must be at most 2 MiB and its declared type must match its bytes. The service computes the content SHA-256 before recognition. When `query` is empty, the configured OpenAI model produces conservative structured visible-text evidence; when it is present, provider recognition is skipped and the query becomes the evidence. Each bounded query is sent to the private CollectFolio `catalog/search` endpoint with the same bearer token.

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
- OpenAI Responses storage is disabled with `store: false`. Provider processing still follows the API account's data controls and applicable abuse-monitoring rules; see [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint).
- Recognition is bounded to 15 seconds with SDK retries disabled. All catalog attempts share a 14-second deadline, each response is capped at 8 MiB, and the browser independently aborts after 30 seconds.
- The result's `imageRetained: false` field is a mandatory service assertion, not a claim that an external provider has zero retention.

Any future persistence, asynchronous enrichment, broader image use, or different provider requires a new contract version, privacy review, retention disclosure, and CollectFolio UI approval before rollout.

## Verification

```sh
pnpm run build:packages
pnpm --filter @localclear/api exec vitest run test/card-lookups.test.ts test/auth-config.test.ts --maxWorkers=1
pnpm --filter @localclear/api typecheck
pnpm test
pnpm typecheck
pnpm build
pnpm format:check
```

Production qualification must include valid and expired CollectFolio tokens, a token from the CollectCapture issuer, origin rejection, malformed and oversized images, manual-query provider bypass, provider/catalog outage, rate limiting, response-cache headers, log inspection, and confirmation that no crop appears in database or object storage.
