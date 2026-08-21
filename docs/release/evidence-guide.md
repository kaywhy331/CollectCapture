# Production release evidence guide

The admin release workflow is deliberately fail-closed. A public-beta draft needs at least two selected connectors; a V1 public draft needs at least three and may not depend on eBay. Every selected connector must be enabled, policy-approved, owned, version-bounded, canary-backed, and linked to production-method approval evidence.

Submission requires one URL, SHA-256, status, and verification time for each of: threat model, security architecture review, mobile penetration test, API penetration test, dependency scan, secret scan, SBOM, incident-response plan, data-retention policy, privacy policy, and terms of use. URLs should point to immutable, access-controlled receipts rather than editable summaries.

Threat/security reviews and governance documents must be recorded as `approved`; penetration tests, scans, and the SBOM verification must be recorded as `passed`. The domain gate rejects a swapped or weaker status even when every evidence kind is present.

The author submits the draft but cannot approve it. Two distinct administrators approve; one of those approvers records deployment. Rejection and rollback remain auditable. Creating code or draft documents does not satisfy an approval receipt.

External product gates—marketplace permission, app-store declarations, independent penetration testing, legal approval, 500-item AI/pricing benchmarks, usability results, pilot security history, 1,000-attempt reliability data, and production SLO evidence—remain blocked until dated evidence is attached.
