# LocalClear requirement traceability

This ledger maps every functional requirement in PRD section 11 to the repository as of 2026-08-20. A repository-local result is not a public-release claim.

Status meanings:

- **Verified** — the behavior is implemented and has local automated, compile, or migration evidence.
- **Partial** — a meaningful path exists, but part of the stated behavior still needs implementation or device-level proof.
- **Deferred** — an optional `Should` item is intentionally outside the technical MVP.
- **External gate** — completion requires permission, independent review, a production environment, or measured field evidence that cannot be manufactured in source code.

## Accounts and household preferences

| ID     | Status   | Evidence and boundary                                                                                                                                                                                                                                                 |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACC-01 | Partial  | Expo implements PKCE Apple, Google, and email-link Supabase Auth flows, while the API requires asymmetric Supabase JWKS verification in production; provider-console registration, signed app credentials, and production redirect validation remain deployment work. |
| ACC-02 | Verified | One household profile is implemented, with a future-ready `household_members` relation and household-scoped API/RLS authorization.                                                                                                                                    |
| ACC-03 | Verified | Onboarding, strict contracts, API persistence, SQL constraints, and edit UI cover ZIP, radius, exchange preferences, availability, meetup locations, and price rules.                                                                                                 |
| ACC-04 | Verified | Only user-facing payment wording is modeled; there is no payment credential, account, or transaction integration.                                                                                                                                                     |
| ACC-05 | Verified | Household default offer percentage and versioned item-specific minimum prices are validated and enforced in pricing and buyer-response logic.                                                                                                                         |
| ACC-06 | Verified | Export and deletion endpoints revoke devices, cancel jobs, delete private media/data/identity, issue a non-identifying receipt, and are covered by an end-to-end API test.                                                                                            |

## Seller Hub

| ID     | Status        | Evidence and boundary                                                                                                                                                                                               |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HUB-01 | Verified      | Single-use QR challenges, HMAC binding, P-256 possession proof, Android Keystore keys, Google Code Scanner UI, and pairing API are implemented and tested.                                                          |
| HUB-02 | Verified      | Android `minSdk` is 30 (Android 11), and domain/API contracts reject older devices.                                                                                                                                 |
| HUB-03 | Verified      | Authenticated check-in records online, battery, charging, network, Seller Hub version, marketplace app version, capabilities, and last check-in; mobile renders the state.                                          |
| HUB-04 | External gate | The device-only credential boundary and connector interface are implemented; a real official-app connector requires a reviewed, permitted marketplace method. The repository ships only an internal sandbox module. |
| HUB-05 | Verified      | Strict schemas reject credential-shaped fields, SQL has no marketplace secret columns, Android performs login locally, and tests guard the boundary.                                                                |
| HUB-06 | Verified      | Backend commands use canonical P-256 ECDSA envelopes and seven fixed actions; Android trusts one configured public key and rejects all other actions.                                                               |
| HUB-07 | Verified      | Protocol and API tests cover malformed, altered, expired, replayed, cross-device, cross-household, and cross-app-version traffic; nonces persist on both sides.                                                     |
| HUB-08 | Partial       | Required pause states and deterministic unexpected-screen rejection exist, but login/MFA/CAPTCHA recognition still requires a permitted production official-app module and device test.                             |
| HUB-09 | Partial       | Jobs preserve a verified resume state, in-app/push notifications are dispatched, and resume is tested; official-app field-preservation evidence awaits a production connector.                                      |
| HUB-10 | Verified      | Unpairing revokes the device credential, disables its connections, cancels every active device job, returns logout/cache instructions, and Android exposes local secure-data clearing.                              |
| HUB-11 | Verified      | Seller Hub purges bounded temporary media and clears job media on completion; cloud diagnostic/media retention workers delete objects before rows.                                                                  |
| HUB-12 | Verified      | The app exposes no ADB, shell, accessibility service, or arbitrary script endpoint; its network client accepts only the narrow signed protocol.                                                                     |
| HUB-13 | Deferred      | The optional Windows bridge is not part of the technical MVP; Android is independently buildable and operable.                                                                                                      |
| HUB-14 | External gate | Policy/release controls prohibit emulator or obfuscation evidence, but production compliance must be established during independent connector review.                                                               |

## Photo capture and media

| ID     | Status   | Evidence and boundary                                                                                                                                                                                                                                                                                    |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CAP-01 | Verified | Expo supports camera capture and multi-select from the image library.                                                                                                                                                                                                                                    |
| CAP-02 | Verified | Mobile and strict API/domain contracts enforce 1–12 images; boundary tests cover 0, 1, 12, and 13.                                                                                                                                                                                                       |
| CAP-03 | Verified | Continuous batch mode keeps the camera session active, and an API test persists 25 items in one batch. Field usability remains a completion gate.                                                                                                                                                        |
| CAP-04 | Partial  | The multimodal provider assesses blur, lighting, glare, and framing and the review UI surfaces results; calibrated device/benchmark accuracy is not yet evidenced.                                                                                                                                       |
| CAP-05 | Verified | Enrichment returns bounded label/model/damage/scale/accessory suggestions and the review UI displays them.                                                                                                                                                                                               |
| CAP-06 | Partial  | Capture normalizes orientation through native processing, bounds resolution, and lightly recompresses without generative edits; content-aware auto-crop and exposure correction still need a validated native pipeline.                                                                                  |
| CAP-07 | Partial  | Mobile JPEG re-encoding removes requested EXIF, and the API independently verifies private object bytes, SHA-256, media type, and JPEG/PNG/WebP GPS metadata before accepting capture or replacement. Synthetic container tests cover the fail-closed gate; a real-device GPS EXIF fixture test remains. |
| CAP-08 | Verified | Vision assessment flags faces/documents/addresses/plates, and users can crop/replace or explicitly clear a warning before publish. Replacements delete the old private object.                                                                                                                           |
| CAP-09 | Verified | AI lead-photo scores deterministically reorder media and select exactly one lead while preserving stable tie order.                                                                                                                                                                                      |

## AI identification and listing generation

| ID    | Status   | Evidence and boundary                                                                                                                                                                                                 |
| ----- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI-01 | Verified | The OpenAI Responses adapter returns strict item type, category, brand, and model suggestions with evidence.                                                                                                          |
| AI-02 | Verified | The multimodal prompt and schema extract visible label/model/serial/dimension/packaging text conservatively with per-fact evidence.                                                                                   |
| AI-03 | Verified | Expo scans UPC/EAN codes during capture, and the enrichment input also asks the model to transcribe visible barcodes.                                                                                                 |
| AI-04 | Verified | Confidence and bounded alternative matches are required by schema and rendered during review.                                                                                                                         |
| AI-05 | Verified | Structured output permits at most three material unresolved questions; domain tests reject a fourth.                                                                                                                  |
| AI-06 | Verified | The provider generates title, description, condition summary, details, and specifications, which the user edits and approves into an immutable listing version.                                                       |
| AI-07 | Verified | The connector mapper produces versioned platform titles, descriptions, categories, and fields with length/required-field enforcement.                                                                                 |
| AI-08 | Verified | Every approved specification carries image-derived, catalog-derived, user-confirmed, or inferred provenance plus confidence.                                                                                          |
| AI-09 | Verified | Inferred or below-threshold model-specific facts are excluded and unresolved specifications block publishing.                                                                                                         |
| AI-10 | Verified | Server-owned text rules and current-media model signals derive restricted/recalled/unsafe/age-regulated review or block states; client-supplied clearance is rejected and every publish path rechecks a clear screen. |
| AI-11 | Verified | A tested clearing engine recommends sell, bundle, giveaway, donate, recycle, or discard based on value, effort, condition, and safety.                                                                                |
| AI-12 | Verified | A tested related-item scorer suggests bundles from category, brand/model, title, and active inventory.                                                                                                                |

The PRD’s 500-item accuracy, OCR, copy-acceptance, and pricing-quality thresholds remain external benchmark gates even though all product pathways above are implemented.

## Pricing

| ID     | Status   | Evidence and boundary                                                                                                                                              |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PRI-01 | Verified | The engine returns Sell Fast, Balanced, and Maximize Value recommendations in stable order.                                                                        |
| PRI-02 | Verified | Canonical listings and user overrides enforce a minimum acceptable price.                                                                                          |
| PRI-03 | Verified | Recommendations accept only approved comparable contracts and the production repository currently sources LocalClear’s verified outcomes, not scraped asking data. |
| PRI-04 | Verified | Verified sold outcomes and active asking prices are counted and labeled separately.                                                                                |
| PRI-05 | Verified | Every result includes comparable count, confidence, adjustment factors, and basis text.                                                                            |
| PRI-06 | Verified | Condition, local demand, seasonality, and sale-speed multipliers are applied and tested.                                                                           |
| PRI-07 | Verified | Users can override recommendations while the configured floor remains enforced.                                                                                    |
| PRI-08 | Verified | Every recommendation includes an explicit non-guarantee disclaimer.                                                                                                |

## Canonical listing

| ID     | Status   | Evidence and boundary                                                                                                       |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| LST-01 | Verified | Marketplace-independent item and canonical listing records are the source of truth.                                         |
| LST-02 | Verified | Connector-specific category/field mappings generate persisted variants without mutating canonical content.                  |
| LST-03 | Verified | Condition, dimensions, accessories, defects, storage location, and availability are persisted.                              |
| LST-04 | Verified | Variant and buyer/meetup engines apply saved exchange, payment, negotiation, floor, delivery, and hold rules.               |
| LST-05 | Verified | Mobile provides one consolidated photo/identity/details/price/privacy review and creates a new immutable version for edits. |
| LST-06 | Verified | Candidate selection, batch approval, batch publish API, and mobile batch-publish UI are implemented.                        |
| LST-07 | Verified | Immutable `(item, version)` rows, version-bound variants/jobs, transitions, and audit events preserve history.              |

## Publishing orchestrator

| ID     | Status   | Evidence and boundary                                                                                                          |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| PUB-01 | Verified | One action-scoped job is created per household/item/platform/listing version.                                                  |
| PUB-02 | Verified | A globally unique idempotency key, active-listing guard, repository reuse, and duplicate detection prevent duplicate listings. |
| PUB-03 | Verified | The full PRD state machine, last verified state, transitions, leases, and resumability are implemented and tested.             |
| PUB-04 | Verified | Transient failures use bounded exponential backoff and terminate visibly after the retry budget.                               |
| PUB-05 | Verified | Challenges pause at the interrupted state and resume rather than restart.                                                      |
| PUB-06 | Verified | Supabase Realtime publications, mobile subscriptions, fallback polling, progress UI, and notifications expose live state.      |
| PUB-07 | Verified | Verified results persist platform listing ID, URL, price, title, publish time, and sync time when exposed.                     |
| PUB-08 | Verified | Jobs and telemetry persist structured failure reasons, connector version, and the exact marketplace app-version snapshot.      |
| PUB-09 | Verified | Connector and global publishing kill switches are checked at admission, dispatch, and device polling.                          |
| PUB-10 | Verified | Per-platform rolling minute limits and daily listing caps are enforced before queue admission.                                 |
| PUB-11 | Verified | CAPTCHA, login, MFA, fees/payment, integrity, and unknown screens can only pause or fail; no bypass action exists.             |

## Connector framework

| ID     | Status   | Evidence and boundary                                                                                                                                                         |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CON-01 | Verified | Every strict manifest declares publish, edit, delist, mark-sold, message-read, message-send, and import capabilities.                                                         |
| CON-02 | Verified | Approved, review, internal-only, and disabled policy states are required and environment-gated.                                                                               |
| CON-03 | Verified | Required fields, category mappings, field mappings, and platform length limits are applied by a tested deterministic mapper.                                                  |
| CON-04 | Verified | Android’s tested resolver prioritizes resource ID, content description, and text; coordinates require an exact reviewed screen fingerprint.                                   |
| CON-05 | Verified | Jobs originate in explicit authenticated publish/close actions; the device executes only a fetched, signed, allow-listed command.                                             |
| CON-06 | Verified | AI produces data only; it cannot emit actions, selectors, scripts, or device instructions.                                                                                    |
| CON-07 | Verified | Connector definitions and change rows are versioned, append-only, and remotely disableable.                                                                                   |
| CON-08 | Partial  | Manifests, admin controls, and public-release gates require a versioned canary test ID; execution and independent evidence for real marketplace app upgrades remain external. |
| CON-09 | Verified | Check-in derives marketplace app version, queueing snapshots it, dispatch rechecks it, and unsupported/drifted versions fail closed.                                          |
| CON-10 | Verified | Owner, policy evidence/date, definition version, and immutable connector change history are persisted and visible in admin.                                                   |

## Inventory and delisting

| ID     | Status   | Evidence and boundary                                                                                                                                            |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-01 | Verified | Captured, Draft, Ready, Publishing, Partially Live, Live, Reserved, Sold, and all cleared states are modeled and tested.                                         |
| INV-02 | Verified | Every platform listing has an independent status and external identity.                                                                                          |
| INV-03 | Verified | Immutable listing edits create capability-gated `update_fields` jobs for live connectors.                                                                        |
| INV-04 | Verified | Mobile/API support reserve, sell, relist, archive, delete, giveaway, donate, recycle, and discard transitions with confirmations.                                |
| INV-05 | Verified | One close action plans mark-sold/delist commands across every capable live connector.                                                                            |
| INV-06 | Verified | Unsupported/manual close work is consolidated into one exception task.                                                                                           |
| INV-07 | Verified | Barcode, image fingerprint, strong brand/model, and normalized-title duplicate checks run before publish; active external listing uniqueness is enforced in SQL. |
| INV-08 | Verified | Optional physical storage location is available in item data and review.                                                                                         |
| INV-09 | Verified | Outcomes retain price, destination, days-to-clear, notes, and terminal path for future pricing intelligence.                                                     |

## Messaging and buyer assistance

| ID     | Status   | Evidence and boundary                                                                                                                                                         |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSG-01 | Partial  | Authenticated ingestion immediately redacts/discards raw content and sending is capability/policy-gated; a real approved API or device message-read transport is not shipped. |
| MSG-02 | Verified | A tested classifier covers product question, availability, price offer, trade, delivery, pickup, dimensions/compatibility, scam, and other.                                   |
| MSG-03 | Verified | A bounded deterministic generator creates concise, context-aware suggested replies.                                                                                           |
| MSG-04 | Verified | Tasks begin pending; approval/rejection is explicit, and send state is unreachable without a permitted message-send connector.                                                |
| MSG-05 | Verified | Counter/accept/trade/delivery/hold behavior enforces the floor and saved household/listing rules.                                                                             |
| MSG-06 | Verified | Raw excerpts are address-redacted, listings use approximate location, and private meetup locations require exact user approval.                                               |
| MSG-07 | Verified | Tested detection warns on verification codes, gift cards, overpayment, couriers, deposits, and off-platform migration.                                                        |
| MSG-08 | Verified | Accept, Counter, Decline, and Schedule draft actions are generated and remain approval-bound.                                                                                 |
| MSG-09 | Verified | A positional backup-buyer queue supports promote/remove and creates a new approval-bound follow-up task.                                                                      |

## Meetup and local exchange

| ID     | Status   | Evidence and boundary                                                                                        |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| MTP-01 | Verified | Households store named public meetup locations and public descriptions.                                      |
| MTP-02 | Verified | Recurring availability windows and timezone are validated and editable.                                      |
| MTP-03 | Verified | A tested timezone-aware generator proposes future public meetup slots from saved availability.               |
| MTP-04 | Verified | Porch pickup, buyer pickup, public meetup, and optional local delivery are strict, listing-approved choices. |
| MTP-05 | Verified | Calendar access is not required; meetup records expose stable timestamps/statuses for a future adapter.      |
| MTP-06 | Verified | No payment-processing or settlement endpoint/model exists.                                                   |

## Giveaway and donation lane

| ID     | Status   | Evidence and boundary                                                                       |
| ------ | -------- | ------------------------------------------------------------------------------------------- |
| GIV-01 | Verified | The tested effort/value rule recommends giveaway when a sale is not worthwhile.             |
| GIV-02 | Verified | The clearing engine generates a giveaway-specific title, description, and safe pickup note. |
| GIV-03 | Verified | Given away and donated are successful terminal inventory/outcome states.                    |
| GIV-04 | Verified | Unsafe/low-condition categories receive donation/recycling/disposal destinations and notes. |

## Admin and operations

| ID     | Status   | Evidence and boundary                                                                                                                                                                                           |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPS-01 | Verified | The role-gated Next.js dashboard groups jobs by platform, connector version, marketplace app version, state, success rate, and failure type; production operations routes additionally require Supabase `aal2`. |
| OPS-02 | Verified | Audited connector and feature kill switches take effect without an app release.                                                                                                                                 |
| OPS-03 | Partial  | Upload requires an active, scoped, time-limited grant plus exact user consent and `redacted/privacyScanPassed` assertions; an independently validated screenshot redaction scanner remains.                     |
| OPS-04 | Verified | Connector/feature changes, releases, approvals, deployments, rollbacks, grants, diagnostics, and audits persist; critical histories are SQL-immutable.                                                          |
| OPS-05 | Verified | Policy status, approval evidence URL, review date, production method, canary ID, and owner are governed inputs.                                                                                                 |
| OPS-06 | Verified | The operations API raises failure-spike, account-challenge, and duplicate-rate alerts from the last 24 hours.                                                                                                   |

## Technical and release completion

Repository evidence currently proves the technical MVP’s API, deterministic Android, and import/export connector patterns. All real marketplace definitions are deny-by-default: OfferUp and Craigslist carry their explicit authorization gates; Facebook Marketplace and Nextdoor require platform/legal approval; eBay is disabled and cannot satisfy the V1 connector count.

Public beta and V1 remain blocked by the following PRD section 21 evidence:

- two beta or three V1 legally permitted production connectors, their actual canary results, app/store disclosures, and marketplace approval records;
- the 500-item AI/OCR/pricing benchmark and its accuracy/acceptance thresholds;
- the 25-household usability pilot, timing results, satisfaction/retention measures, and pairing-under-10-minutes evidence;
- 1,000 real item-platform attempts and measured publish, duplicate, resume, delist, and inventory-latency targets;
- production availability, crash-free sessions, performance percentiles, transport/encryption-at-rest attestations, and alert delivery verification;
- WCAG 2.2 AA and real-device large-text/screen-reader audits;
- independent security architecture review plus mobile/API penetration tests with no unresolved high or critical findings;
- counsel/executive approval of privacy, terms, retention, incident-response, and support-access documents.

The release model fails closed until each required receipt has an immutable URL, SHA-256, verification time, two distinct non-author approvals, and an authorized deployment action. Draft documents, sandbox success, or source-code assertions do not satisfy those external gates.
