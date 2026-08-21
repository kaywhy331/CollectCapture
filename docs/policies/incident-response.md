# Incident-response plan

Status: **Draft — requires approval by Security, Privacy/Legal, Operations, and the executive incident owner before public release.**

## Scope and objectives

This plan covers the LocalClear API, mobile app, admin console, Supabase data plane, Seller Hub, signing keys, connector definitions, CI/CD, and vendors. Its objectives are to protect users, contain compromise, preserve admissible evidence, restore safely, and communicate accurately.

Marketplace credentials and sessions should exist only inside official marketplace apps. Any indication that they reached LocalClear infrastructure is a severity-one incident.

## Roles

Before beta, named primary and backup people must be assigned for incident command, security engineering, infrastructure, privacy/legal, customer communications, connector operations, and executive escalation. The incident commander owns the timeline and may activate any remote connector or feature kill switch without waiting for a release.

## Severity and response targets

| Severity | Examples                                                                                                                             |     Acknowledge | Incident command |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------: | ---------------: |
| SEV-1    | Credential/session exposure, signing-key compromise, cross-household disclosure, active account takeover, unsafe automation at scale |      15 minutes |       30 minutes |
| SEV-2    | Confirmed limited data disclosure, exploitable authorization defect, repeated unauthorized listing action                            |      30 minutes |       60 minutes |
| SEV-3    | Contained security defect without confirmed exploitation                                                                             |  1 business day |      As assigned |
| SEV-4    | Hardening issue or false positive                                                                                                    | 3 business days |      As assigned |

Targets begin when monitoring, staff, a user, a vendor, or a researcher reports a credible signal.

## Response procedure

1. Open a restricted incident record; record UTC times, reporter, affected environments, and current evidence without copying unnecessary personal data.
2. Classify severity and activate incident command. Use an out-of-band channel if identity or collaboration systems may be compromised.
3. Contain: disable affected connectors/features, revoke device and service credentials, rotate signing or API keys, isolate workloads, and preserve affected logs and immutable audit rows.
4. Investigate using redacted telemetry. User diagnostics require an active, scoped, expiring support grant and explicit consent. Never request passwords, marketplace cookies, MFA codes, or full private messages.
5. Eradicate the root cause, review dependency and deployment provenance, and add a regression test.
6. Recover progressively through internal, canary, and beta stages. A different authorized reviewer validates the fix and monitoring before broader enablement.
7. Privacy/legal determines contractual, platform, store, insurer, law-enforcement, and regulator notifications and their deadlines. Communications state verified facts, affected data, user actions, and update cadence.
8. Complete a blameless review within five business days of closure. Track owners and deadlines for every corrective action.

## Evidence and exercises

Incident records include an event timeline, audit IDs, redacted telemetry queries, release and SBOM identifiers, containment actions, data-scope analysis, approvals, notifications, recovery evidence, and follow-up tasks. Exercise one credential-boundary scenario and one connector kill-switch scenario before beta, then at least twice yearly.
