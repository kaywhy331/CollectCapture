# Support-access policy

Status: **Draft — requires Security, Privacy/Legal, Support, and Operations approval before public release.**

LocalClear has no standing access to a household. A signed-in user creates a grant for one named support actor, one reason code, selected scopes, and 5–60 minutes. The user may revoke it at any time. Expiry and revocation are enforced server-side for every session request.

Available scopes are limited to redacted publishing-job metadata, coarse device health, and separately consented diagnostic artifacts. A diagnostic grant requires the exact consent phrase. Each uploaded artifact must use the household diagnostic path, be newly hashed, be marked redacted, pass the privacy gate, and carry a second explicit upload confirmation.

Only the assigned operator may open the active session. The response excludes passwords, tokens, cookies, marketplace sessions, full buyer messages, exact locations, clipboard data, and unrelated household content. Diagnostic read URLs expire after 60 seconds. Every grant, revocation, artifact submission, and session view is audited with redacted metadata.

Operators must use managed accounts with MFA, may not share exports or screenshots, and must stop when the task is resolved or consent is withdrawn. Break-glass access is not implemented; a future design requires a separate approved policy, two-person authorization, notice, and retrospective review.

Quarterly access reviews must sample grants and audit rows, confirm actor employment/role, measure expiration and artifact deletion, and record corrective actions.
