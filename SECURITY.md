# Security policy

LocalClear is pre-release software. Do not test against real marketplace accounts, other people’s data, or production infrastructure without written authorization.

Report suspected vulnerabilities privately through the repository’s private vulnerability-reporting feature. Include the affected component, reproduction steps, impact, and any suggested mitigation. Do not include marketplace credentials, session material, full buyer messages, exact addresses, or unredacted user images.

The security owner will acknowledge a report within two business days, assign a severity, and coordinate a remediation and disclosure timeline. Critical and high-severity issues block public release and may activate connector or feature kill switches immediately.

Dependency advisories that require a temporary local patch are tracked in [docs/security/dependency-exceptions.md](docs/security/dependency-exceptions.md). An exception is valid only while its lockfile patch and regression check pass; it is not approval to ship an unmitigated finding.
