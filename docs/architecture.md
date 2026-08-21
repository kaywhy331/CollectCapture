# LocalClear architecture

## Runtime surfaces

LocalClear uses a pnpm monorepo with four independently deployable surfaces:

1. `apps/mobile`: Expo/React Native capture, review, inventory, buyer tasks, meetup, and connection settings.
2. `services/api`: Fastify application services over Supabase Auth/Postgres/Storage/Realtime.
3. `apps/admin`: a restricted Next.js connector-health and operations dashboard.
4. `apps/seller-hub`: Android 11+ Kotlin application. Marketplace sessions and secrets remain inside official marketplace apps on this physical device.

`packages/domain` is the shared contract. It owns canonical schemas, publishing transitions, connector policy gates, inventory lifecycle, and pricing invariants. API or device code cannot invent alternate states.

## Trust boundaries

- The main app authenticates with Supabase. Household row-level security scopes cloud records.
- Item media is private and addressed as `<household UUID>/<item UUID>/<asset>`; device downloads use short-lived signed URLs.
- The backend sends only canonical P-256 ECDSA-signed, expiring, nonce-bound commands from a fixed action allow-list. Every command snapshots and binds the marketplace app version as well as user, household, device, item, platform, connector, and listing version.
- A paired device creates and retains its private key in Android Keystore. Only its public key and health are stored in the backend.
- Marketplace credentials, cookies, refresh tokens, clipboard contents, password fields, and session databases never cross the device boundary.
- Connectors are deny-by-default. Production execution requires an enabled switch, approved policy state, documented production method, approval evidence, supported app version, declared capability, owner, and canary test.
- Login, MFA, CAPTCHA, payment, fee, integrity, and unexpected-screen challenges pause the job. They are never bypassed.

## Execution and data flow

1. Mobile uploads sanitized private media and creates one canonical item.
2. Provider adapters enrich evidence; each specification records provenance and confidence.
3. The user reviews one versioned canonical listing and explicitly approves publishing.
4. The API creates one idempotent job per item/platform/version after restricted-item and connector-policy prechecks.
5. The selected connector executes through an official API, approved import/browser path, or signed Seller Hub command.
6. Every state transition is persisted and streamed to the household.
7. A verified platform ID or URL creates/updates the platform listing.
8. Closing an item creates capable delist/mark-sold jobs plus one consolidated task for manual exceptions.

Server-side API/import jobs are claimed with bounded leases by a horizontally safe dispatcher. Android jobs are pulled only by the paired device, and only signed device receipts may advance them. User routes can resume or cancel a job but cannot forge successful transitions. Notifications use a separately leased outbox with bounded retry.

## Persistence invariants

- One canonical item may have many immutable listing versions.
- `(item_id, version)` is unique for canonical listings.
- The publishing idempotency key is globally unique.
- A partial unique index permits at most one active listing per item/platform.
- Job transitions and connector changes are append-only audit records.
- Canonical listing versions, connector/feature changes, publishing transitions, and audit events are protected by immutable database triggers.
- Composite foreign keys bind every child record to the same household as its parent; a foreign object ID cannot be combined with an attacker-controlled household ID.
- Outcome records retain price, destination, days-to-clear, and terminal clearing path.
- No database table contains marketplace credential or session material.

Authenticated Supabase clients have household-scoped read access plus narrowly scoped self-profile and private-media operations. All governed business mutations flow through the API service role, where state, approval, capability, and audit checks cannot be bypassed by a direct client write. The migration and RLS suite run against stock PostgreSQL in CI.

## Replaceable adapters

Vision, OCR, barcode, catalog, pricing/comparable, restricted-item screening, push, storage, and connector transports are interfaces. Production implementations can change without changing canonical records or job semantics.

## Operations and release governance

- OpenTelemetry exports redacted HTTP traces/metrics and publishing duration, state, version, intervention, retry, duplicate, policy, and confirmation signals through OTLP.
- The operations console is role-gated and exposes connector/app-version health, structured failure groups, anomaly alerts, remote connector/feature switches, user-consented support sessions, and append-only release history.
- Public release is fail-closed: all selected connectors must be permission-backed and canary-bounded; all required evidence receipts must include a hash; authors cannot approve; two distinct administrators approve before one approver deploys.
- Retention sweeps remove expired object-storage content before deleting its metadata. Account deletion revokes devices and active jobs before media, relational data, and the Supabase identity are removed.
