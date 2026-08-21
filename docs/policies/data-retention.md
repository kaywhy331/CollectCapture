# Data-retention and deletion policy

Status: **Draft — requires Privacy/Legal, Security, and data-owner approval before public release.** Durations below are proposed engineering defaults, not an approved legal schedule.

## Proposed schedule

| Data class                                                                  | Proposed retention                                                                                             | Deletion trigger/control                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Household, item, canonical listing, meetup, outcome, and buyer-task records | While the account is active                                                                                    | User item/account deletion; cascade and object deletion                              |
| Private item media                                                          | While its item/account is active                                                                               | Item/account deletion removes objects and records                                    |
| Seller Hub temporary media                                                  | 15 minutes by default; configurable up to 24 hours                                                             | Delete immediately after each command, on local clear, and at deadline               |
| Listing export packages                                                     | 24 hours                                                                                                       | One-time confirmation or expiry sweeper                                              |
| Diagnostic images                                                           | Until the support grant expires, and never more than 60 minutes after submission under the current grant limit | Expiry sweeper deletes object and row; signed read URLs last 60 seconds              |
| Push delivery metadata                                                      | 30 days after terminal delivery                                                                                | Scheduled purge; token removed when disabled/account deleted                         |
| Publishing transitions and redacted audit events                            | 24 months while account is active                                                                              | Scheduled purge or account deletion, subject to approved legal hold                  |
| De-identified deletion receipts                                             | 7 years proposed                                                                                               | Scheduled purge; contains only keyed subject hash and timestamps                     |
| Operational metrics/traces                                                  | 30 days                                                                                                        | Collector-side TTL; no message bodies, credentials, exact addresses, or image pixels |
| CI artifacts and SBOMs                                                      | 90 days; release SBOMs for release lifetime                                                                    | Repository retention and release lifecycle                                           |

## Rules

- Collection is purpose-limited and tenant-scoped. Marketplace passwords, cookies, tokens, session databases, clipboard contents, and password-field pixels are prohibited cloud data.
- Account deletion revokes device credentials, cancels active jobs, deletes cloud objects and household rows, deletes the authentication identity, requests local-cache deletion, and returns a keyed non-identifying receipt.
- A legal hold must identify authority, custodian, scope, start, review date, and approver. It must not preserve prohibited credentials or unrelated content.
- Backups must inherit the approved deletion window; restoration procedures must replay tombstones before serving restored data.
- Retention jobs emit counts and failure codes, never the deleted content. Operations alerts on missed sweeps.

Approval must attach evidence that every scheduled deletion path, backup behavior, and production storage lifecycle rule has been tested.
