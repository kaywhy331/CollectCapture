# Deploy the standalone card-lookup service

The standalone CollectCapture process serves only `GET /health` and authenticated `POST /v1/card-lookups`. It does not construct the LocalClear application, open a PostgreSQL connection, use Supabase Storage, run dispatchers, or require any of the full API's production settings.

## Runtime configuration

Set these values in the deployment platform's secret or environment manager:

```text
OPENAI_API_KEY=<server-only secret>
OPENAI_MODEL=<reviewed vision-capable model>
COLLECTFOLIO_APP_URL=https://<exact-collectfolio-browser-origin>
COLLECTFOLIO_SUPABASE_URL=https://<collectfolio-project>.supabase.co
COLLECTFOLIO_SUPABASE_JWKS_URL=             # optional custom discovery URL
COLLECTFOLIO_CATALOG_URL=https://<collectfolio-private-catalog-origin>
HOST=0.0.0.0                                # container default
PORT=4100                                   # platform PORT is also accepted
LOG_LEVEL=info
```

No `DATABASE_URL`, CollectCapture Supabase credential, service-role key, storage bucket, device key, public LocalClear URL, or telemetry collector is required. Startup fails if a required value is missing, an internet-facing URL is not HTTPS, or the browser URL is not an exact origin.

## Run from the workspace

For local development, loopback HTTP URLs are accepted:

```sh
pnpm dev:card-lookups
```

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

## Edge and scaling requirements

- Terminate TLS at the platform or reverse proxy and expose only HTTPS publicly.
- Preserve `Authorization`, `Origin`, `Content-Type`, and `X-Request-Id` request headers. Do not log authorization values or request bodies at the edge.
- Allow request bodies of at least 3,000,000 bytes and upstream request timeouts longer than 30 seconds.
- Route health checks to `GET /health`. A healthy response is `{"status":"ok","service":"collectcapture-card-lookups"}`.
- Keep one service replica for the initial deployment. The authenticated 30-lookups/hour counter uses Fastify's in-memory store and is therefore enforced per process. Multiple replicas require a reviewed shared rate-limit store before they can preserve the contract.
- Do not enable sticky caches or response caching for `POST /v1/card-lookups`; the application returns `Cache-Control: no-store` and `Pragma: no-cache`.

CollectFolio should call the public base URL plus `/v1/card-lookups` and send its own Supabase access token. The service verifies that token against the independently configured CollectFolio issuer/JWKS; CollectCapture application tokens are never a fallback.

## Deployment qualification

Before directing CollectFolio traffic to a release:

1. Confirm `/health` succeeds through the public TLS endpoint.
2. Confirm the exact configured CollectFolio origin receives the CORS allow-origin header and a different origin does not.
3. Exercise a valid token, an expired token, and a token from a different issuer.
4. Exercise both an image-driven lookup and a manual-query lookup; confirm the manual query does not invoke vision recognition.
5. Confirm malformed, mismatched, GPS-bearing, and oversized images are rejected.
6. Confirm provider and catalog timeouts fail without echoing a bearer token or image data in application or edge logs.
7. Confirm lookup responses are not cached and no crop or result appears in a database, object store, filesystem volume, or log sink.
8. Confirm the 31st request from one principal within an hour receives HTTP 429 while another principal remains independent.

Rollback by restoring the previous image digest. The service has no schema migration, persistent job, or stored lookup state to unwind.
