# Deploy the standalone card-lookup service

The standalone CollectCapture process serves only `GET /health` and authenticated `POST /v1/card-lookups`. It does not construct the LocalClear application, open a PostgreSQL connection, use Supabase Storage, run dispatchers, or require any of the full API's production settings.

## Runtime configuration

Set these values in the deployment platform's secret or environment manager:

```text
CARD_RECOGNITION_PROVIDER=openai|ollama|groq
OPENAI_API_KEY=<required only for openai>
OPENAI_MODEL=<reviewed OpenAI vision model>
OLLAMA_BASE_URL=http://127.0.0.1:11434        # or https://ollama.com
OLLAMA_API_KEY=<required for direct ollama.com access>
OLLAMA_MODEL=<reviewed Ollama vision model>
OLLAMA_TIMEOUT_MS=120000
GROQ_API_KEY=<required only for groq>
GROQ_MODEL=qwen/qwen3.6-27b
GROQ_TIMEOUT_MS=60000
COLLECTFOLIO_APP_URL=https://<exact-collectfolio-browser-origin>
COLLECTFOLIO_SUPABASE_URL=https://<collectfolio-project>.supabase.co
COLLECTFOLIO_SUPABASE_JWKS_URL=             # optional custom discovery URL
COLLECTFOLIO_CATALOG_URL=https://<collectfolio-private-catalog-origin>
HOST=0.0.0.0                                # container default
PORT=4100                                   # platform PORT is also accepted
LOG_LEVEL=info
```

No `DATABASE_URL`, CollectCapture Supabase credential, service-role key, storage bucket, device key, public LocalClear URL, or telemetry collector is required. Startup fails if a shared value or the selected provider's secret is missing, an internet-facing integration URL is not HTTPS, or the browser URL is not an exact origin. Blank keys for providers that are not selected are accepted.

## Run from the workspace

For the easiest local launch, copy the dedicated template, fill in its empty and local-service values, and run one command. Loopback HTTP URLs are accepted:

```sh
cp .env.card-lookups.example .env.card-lookups.local
pnpm launch:card-lookups
```

The launcher loads `.env.card-lookups.local`, validates the required settings, builds the workspace packages and API, then starts the standalone server. Use `pnpm launch:card-lookups -- --watch` for TypeScript watch mode, or `-- --env-file /secure/path/card-lookups.env` to load a different file. Exported environment values take precedence. The lower-level `pnpm dev:card-lookups` command remains available when the environment is already exported and the workspace packages are built.

For a built workspace:

```sh
pnpm run build:packages
pnpm --filter @localclear/api build
pnpm start:card-lookups
```

## Build and run the container

The provider-neutral image uses Node.js 22, installs production dependencies into a dedicated deployment directory, runs as an unprivileged user, and includes a `/health` health check.

```sh
docker build -f Dockerfile.card-lookups -t collectcapture-card-lookups .
docker run --rm \
  --env-file /secure/path/collectcapture-card-lookups.env \
  -p 4100:4100 \
  collectcapture-card-lookups
```

Do not bake credentials into the image or commit the environment file. A platform may override `PORT`; the included health check follows that value.

For Docker Desktop on RED PC, including one-command Groq, Ollama Cloud, CPU Ollama, NVIDIA Ollama, model warm-up, and accuracy qualification, use [the RED PC guide](red-pc-card-lookups.md).

## Edge and scaling requirements

- Terminate TLS at the platform or reverse proxy and expose only HTTPS publicly.
- Preserve `Authorization`, `Origin`, `Content-Type`, and `X-Request-Id` request headers. Do not log authorization values or request bodies at the edge.
- Allow request bodies of at least 3,000,000 bytes. Align upstream and client deadlines with the selected recognition timeout plus the 14-second catalog deadline; the current CollectFolio browser deadline remains 30 seconds.
- Route health checks to `GET /health`. A healthy response is `{"status":"ok","service":"collectcapture-card-lookups"}`.
- Keep one service replica for the initial deployment. The authenticated 30-lookups/hour counter uses Fastify's in-memory store and is therefore enforced per process. Multiple replicas require a reviewed shared rate-limit store before they can preserve the contract.
- Do not enable sticky caches or response caching for `POST /v1/card-lookups`; the application returns `Cache-Control: no-store` and `Pragma: no-cache`.

CollectFolio should call the public base URL plus `/v1/card-lookups` and send its own Supabase access token. The service verifies that token against the independently configured CollectFolio issuer/JWKS; CollectCapture application tokens are never a fallback.

## Deployment qualification

Before directing CollectFolio traffic to a release:

1. Confirm `/health` succeeds through the public TLS endpoint.
2. Confirm the exact configured CollectFolio origin receives the CORS allow-origin header and a different origin does not.
3. Exercise a valid token, an expired token, and a token from a different issuer.
4. Exercise both an image-driven lookup and a manual-query lookup; confirm the configured provider/model provenance is returned and the manual query does not invoke vision recognition.
5. Confirm malformed, mismatched, GPS-bearing, and oversized images are rejected.
6. Confirm provider and catalog timeouts fail without echoing a bearer token or image data in application or edge logs.
7. Confirm lookup responses are not cached and no crop or result appears in a database, object store, filesystem volume, or log sink.
8. Confirm the 31st request from one principal within an hour receives HTTP 429 while another principal remains independent.
9. Run the representative card benchmark for the exact provider/model/hardware combination and retain its accuracy and latency receipt.

Rollback by restoring the previous image digest. The service has no schema migration, persistent job, or stored lookup state to unwind.
