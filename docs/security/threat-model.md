# LocalClear threat model

Status: engineering baseline for independent security review. Scope: mobile app, API, Supabase data plane, signed command channel, Seller Hub, admin dashboard, and connector definitions.

## Protected assets

- Household identity and approximate location
- Private item media and redaction decisions
- Seller Hub private key and marketplace sessions
- Canonical listings, buyer excerpts, meetup details, price floors, and outcomes
- Connector definitions, approval evidence, feature switches, and audit history
- Publishing command integrity, freshness, scope, and idempotency

Marketplace passwords, cookies, refresh tokens, and session databases are deliberately not cloud assets because they must never leave the official marketplace apps on the Seller Hub.

## Trust boundaries and threats

| Boundary                     | Principal threats                                                         | Required controls                                                                                                                              | Verification evidence                              |
| ---------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| User → mobile/API            | Account takeover, cross-household access, forged object IDs               | OAuth/email auth, short-lived tokens, household RLS, ownership checks, rate limits                                                             | Auth integration tests and RLS policy tests        |
| Mobile → private media       | EXIF address leak, public object access, unauthorized sharing             | Client/server EXIF stripping, private bucket, household path policy, short-lived signed URLs, optional redaction                               | Media pipeline tests and storage-policy tests      |
| API → Seller Hub             | Forged/altered/expired/replayed/cross-device job                          | P-256 ECDSA signature, canonical payload, expiry, nonce, household/device/item/platform/app-version scope, idempotency key                     | Command protocol test vectors and device tests     |
| Seller Hub → official app    | Arbitrary control, credential capture, CAPTCHA bypass, unintended publish | Fixed action allow-list, deterministic versioned connector, supported-version gate, login privacy mode, explicit user initiation, pause states | Android instrumentation and connector canary tests |
| Admin → production connector | Unauthorized enablement, erased history, excessive support access         | MFA/SSO, least privilege, two-person release workflow, append-only changes, reason/consent/time-bound grants                                   | Access review and audit tests                      |
| Buyer content → AI/user      | Prompt injection, scams, address disclosure, rules bypass                 | Treat messages as untrusted data, redact excerpts, fixed response policy, price/trade/delivery enforcement, explicit send/address approval     | Adversarial buyer-message test suite               |
| Dependencies/build → release | Malicious dependency, leaked secret, unsigned artifact                    | Lockfile policy, dependency/secret scanning, isolated CI, signed builds, SBOM                                                                  | CI release-gate evidence                           |

## Abuse cases

1. A stolen bearer token requests another household’s item. RLS and API ownership checks deny it.
2. A captured command is replayed. The device rejects the consumed nonce even before idempotency enforcement.
3. A command swaps `itemId`, `platform`, or `deviceId`. Canonical signature verification fails and the device records a redacted rejection.
4. An operator enables OfferUp or Craigslist without approval. The policy gate still blocks non-approved status/evidence; the change is audited.
5. Marketplace UI shows login, MFA, CAPTCHA, fees, or an unknown screen. Automation enters a visible pause and disables diagnostics during credential entry.
6. A buyer asks for verification codes, remote payment, or an exact address. The response engine warns and requires explicit user action.
7. An image contains GPS EXIF or a visible address. External publish is blocked until metadata removal and the chosen redaction decision complete.
8. A device is revoked during a job. Key revocation and job cancellation prevent later execution; local cache deletion is requested.

## Logging and diagnostics

Allowed: object IDs, connector/app version, state duration, structured failure code, retry count, challenge type, confirmation method, policy state, coarse device health.

Prohibited: passwords, session tokens, cookies, full private messages, clipboard contents, password-field pixels, unredacted addresses, and diagnostic screenshots without explicit consent. Login privacy mode disables capture entirely.

## Retention and deletion

- Temporary Seller Hub media has an explicit `delete_after` deadline and deletion receipt.
- Diagnostic screenshots are opt-in, redacted, short-lived, and access-audited.
- Account deletion revokes device keys, cancels active jobs, deletes cloud records according to approved retention policy, requests local-cache deletion, and records completion.
- Audit and legal-retention exceptions must be documented without retaining marketplace credentials or unnecessary message content.

## Release gate

Public release remains blocked until an independent reviewer validates this model, mobile/API penetration tests report no unresolved critical or high findings, dependency and secret scans pass, and incident-response, privacy, retention, and support-access policies are approved.
