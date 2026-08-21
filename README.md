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

The optional CollectFolio integration exposes a separately authenticated, stateless `POST /v1/card-lookups` route. Configure its exact browser origin, CollectFolio Supabase issuer/JWKS, private catalog URL, and OpenAI key as one fail-closed group. It accepts only a bounded crop, does not persist that crop, returns identity suggestions without prices or automatic approval, and never uses the LocalClear/CollectCapture application issuer as an authentication fallback. Configuration, request contract, privacy limits, and qualification are documented in [docs/collectfolio-card-lookup.md](docs/collectfolio-card-lookup.md).

The Android 11+ companion lives in `apps/seller-hub` and builds with its checked-in, checksum-pinned Gradle wrapper. It requires the base64 DER public half of the same P-256 command key described in its README.

CI also applies the production migration to PostgreSQL 16 and executes `supabase/tests/rls.sql`, then compiles/tests the Android app and runs formatting, type, test, web, API, dependency, secret, CodeQL, and SBOM gates.

Run `pnpm security:dependencies` to verify lockfile-enforced dependency patches before auditing production dependencies. Temporary, reviewed advisory handling is documented in [docs/security/dependency-exceptions.md](docs/security/dependency-exceptions.md).

Marketplace credentials never enter LocalClear services. Restricted connectors remain disabled unless their permission record allows production use.
