# LocalClear

LocalClear is a photo-first assistant for clearing unwanted household items through permitted local marketplaces. It creates one canonical listing, publishes through policy-gated connectors, helps with buyer replies and meetups, and closes inventory everywhere without handling payments or shipping.

The product specification is [PRD/CollectCapture_PRD_v1.md](PRD/CollectCapture_PRD_v1.md). The current implementation/evidence boundary is recorded in [docs/requirements-traceability.md](docs/requirements-traceability.md); public beta is deliberately blocked until its external marketplace, benchmark, security, legal, and pilot gates have dated receipts.

## Development

Requirements: Node.js 22+ and pnpm 11+.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Copy `.env.example` to an untracked environment file and supply local Supabase credentials. The API requires OpenAI and Supabase service-role credentials together for photo enrichment, and production additionally requires OTLP, account-deletion, admin-origin, and P-256 command-signing configuration.

The CollectFolio integration exposes a separately authenticated, stateless `POST /v1/card-lookups` route. Its recommended standalone process runs without PostgreSQL or the rest of the LocalClear production configuration; the full API can also register the same route optionally. Configure its exact browser origin, CollectFolio Supabase issuer/JWKS, private catalog URL, and selected OpenAI, Ollama, or Groq recognition provider as one fail-closed group. It accepts only a bounded crop, does not persist that crop, returns identity suggestions without prices or automatic approval, and never uses the LocalClear/CollectCapture application issuer as an authentication fallback. The [service contract](docs/collectfolio-card-lookup.md), [deployment runbook](docs/deploy-card-lookups.md), [RED PC Docker guide](docs/red-pc-card-lookups.md), and [RED PC public HTTPS tunnel guide](docs/red-pc-cloudflare-tunnel.md) cover configuration, privacy, container deployment, qualification, and cross-network access.

To launch that API locally, copy `.env.card-lookups.example` to `.env.card-lookups.local`, fill in the values, and run `pnpm launch:card-lookups`. Add `-- --watch` for source watch mode. The launcher loads the dedicated environment file, checks required settings, builds the needed workspace packages, and starts only the standalone lookup server.

The Android 11+ companion lives in `apps/seller-hub` and builds with its checked-in, checksum-pinned Gradle wrapper. It requires the base64 DER public half of the same P-256 command key described in its README.

CI also applies the production migration to PostgreSQL 16 and executes `supabase/tests/rls.sql`, then compiles/tests the Android app and runs formatting, type, test, web, API, dependency, secret, CodeQL, and SBOM gates.

Run `pnpm security:dependencies` to verify lockfile-enforced dependency patches before auditing production dependencies. Temporary, reviewed advisory handling is documented in [docs/security/dependency-exceptions.md](docs/security/dependency-exceptions.md).

Marketplace credentials never enter LocalClear services. Restricted connectors remain disabled unless their permission record allows production use.
