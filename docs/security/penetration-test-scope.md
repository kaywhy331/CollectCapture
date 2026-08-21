# Independent penetration-test scope

Status: **Draft statement of work — no test has been performed.**

Test a dedicated non-production environment and physical Android devices with written authorization. Include authentication and account recovery, object/tenant authorization, RLS and Storage policies, API input and rate controls, media URLs and EXIF, account export/deletion, admin roles, support grants, diagnostic consent, connector/feature controls, release workflow, pairing, key storage, command signature/expiry/replay/scope, malicious receipts, deep links, push payloads, buyer-message injection/scams, and dependency/build provenance.

Explicitly test that marketplace credentials and sessions cannot leave official apps, unsupported screens and app versions pause, and no ADB endpoint, arbitrary shell, arbitrary script, CAPTCHA bypass, or cross-device command exists. Do not test real marketplace accounts without separate platform authorization.

The independent report must identify the commit/build, environment, tools, manual coverage, exclusions, proof for each finding, severity, retest status, and an attestation that no unresolved critical or high-severity findings remain. Mobile and API results are separate required production-release evidence receipts.
