# Dependency security exceptions

## `image-size` 1.2.1 via Metro

Reviewed: 2026-08-20

The Expo/React Native Metro toolchain transitively resolves `image-size` 1.2.1. GitHub advisories [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) and [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) describe event-loop denial of service from zero-length JXL/HEIF boxes and ICNS entries. The upstream repository is archived and, as of the review date, GitHub lists no patched release.

The workspace therefore applies `patches/image-size@1.2.1.patch` during every pnpm install. It rejects undersized ISO-BMFF boxes and ICNS entries before an offset-controlled loop can repeat. `pnpm security:verify-patches` runs the published malicious structures in isolated workers with hard timeouts and confirms that a valid PNG still parses. `pnpm security:dependencies` runs that regression before the production dependency audit. The lockfile records the patch hash, and pnpm 11 fails installation if the patch no longer applies.

The two audit and dependency-review GHSA allowances cover this locally remediated package only. They must be removed when Expo/Metro selects a maintained, fixed parser. Review this exception on every Expo, React Native, Metro, or `image-size` update and at least every 30 days while release work is active.

The separate `uuid` advisory is not excepted: the workspace overrides the transitive Xcode-project utility dependency to 11.1.1 or newer.
