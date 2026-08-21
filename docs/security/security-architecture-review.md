# Security architecture review record

Status: **Awaiting independent review. This document is a review packet, not an approval.**

## Review scope

- Mobile authentication, capture, EXIF removal, redaction, and private media access
- API authorization, tenant checks, RLS, rate limits, exports, and deletion
- P-256 ECDSA pairing/commands/receipts, nonce replay defense, expiry, and scope binding
- Seller Hub Android Keystore, local cache, deterministic action allow-list, and absence of public ADB/shell
- Connector policy/version gates, kill switches, canaries, release approvals, and audit immutability
- Admin identity/roles, temporary support grants, diagnostics, and logging/telemetry redaction
- CI dependency/secret/code scanning, SBOM generation, artifact provenance, and deployment separation

## Evidence to attach

Attach dated data-flow and deployment diagrams, the threat model, RLS integration results against a disposable database, command protocol vectors, Android test/build receipts, dependency and secret scan reports, SBOM hash, backup/deletion evidence, key-management runbook, and the exact commit reviewed.

## Required sign-off

The independent reviewer records reviewer identity/organization, scope exclusions, methodology, findings with severity and owner, residual risk, approval or rejection, signature, and UTC date. Any unresolved critical or high-severity finding blocks release. The approval receipt URL and SHA-256 are entered into the governed production-release record.
