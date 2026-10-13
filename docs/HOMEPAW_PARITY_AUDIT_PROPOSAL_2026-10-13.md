# HomePaw to Operro parity audit: proposal after the final parity operations batch (13 October 2026)

A **proposal for owner review**, not an accepted status. Evidence is local only (PostgreSQL 16 gates, a populated-upgrade rehearsal, the web suite, a real-database restore rehearsal, and owner-session browser checks on a private local stack). Nothing was tested on a hosted project, a real WhatsApp provider, real mail or a production restore. "Implemented" here means a real route/RPC with tests and local proof; it does not mean the owner's live workflow passed QC. It supersedes [HOMEPAW_PARITY_AUDIT_PROPOSAL_2026-10-12.md](HOMEPAW_PARITY_AUDIT_PROPOSAL_2026-10-12.md) for the eight rows below. Commit under test: `2b8d3be6368c3d495a971154c6688f4f8a8789e3`.

## Count

- **The eight rows this program targeted (#1, #31, #34, #38, #39, #41, #43, #44):** proposed **3 Implemented** (#1, #31, #39), **4 Partial** (#34, #38, #41, #44) and **1 Blocked** (#43). That is 3 + 4 + 1 = 8.
- **The other 36 rows** are carried unchanged from the previous proposal (accepted baseline, not re-audited): 36 Implemented.
- **Proposed overall: 39 Implemented, 4 Partial, 1 Blocked, 0 Missing.**
- **This is not full parity**, and it must not be advertised as such: the three newly Implemented rows carry the caveats below, the Partial and Blocked rows need external action, and live owner QC of every row remains pending.

| # | Capability | Proposed | Why (what changed) | What keeps it from more |
|---|---|---|---|---|
| 1 | Dashboard analytics | **Implemented** (pending owner acceptance of the rule) | Operational alerts (earlier batch) plus a manual immutable marketing-spend ledger and a labelled source return: cash collected this period from this period's new customers per source and currency against recorded net spend; no ratio without spend. | It is not lifetime value, campaign attribution or profit, and late payers are not counted. The owner must accept the attribution rule (decision D1). |
| 31 | Financial operations | **Implemented** as a mapped cash-control position | Cash-control register (earlier) plus immutable effective-dated mappings of payments, expenses and payroll to accounts and a mapped position with a report of what it leaves out. | It is not a ledger, bank reconciliation, profit or tax. The owner's mappings and opening balances decide its truth (D2). |
| 34 | WhatsApp center | **Partial** | Manual batches and event log (earlier) plus a disabled official-provider boundary, owner consent attestation and a setup runbook. | No provider, credential, consent flow, webhook or staging test exists; Operro stores no delivered or read state (D3). |
| 38 | Export / ownership | **Partial** | Reviewed archive scope and retention (earlier), now also covering the spend ledger, mappings and business defaults, plus a guarded restore-script generator proven on local PostgreSQL. | No hosted or disposable-project restore was performed; Storage bodies, Auth identities and secrets are not in the archive (D4). |
| 39 | Business configuration | **Implemented** | Branch calendar hours (earlier) plus typed, concurrency-safe, audited source-label suggestions and a default invoice due period; every other HomePaw key is mapped. | Currency (deliberately immutable) and platform billing are not business-owned. Labels are suggestions, not a closed list (D5). |
| 41 | Accounts / permissions | **Partial** | Invitation claim role tests (earlier) plus a platform readiness summary, a read-only staging post-condition script and an updated QC runbook. | The hosted real-mail invitation and multi-organization QC has not run (D6). |
| 43 | Storage / maintenance | **Blocked** | Consent record (earlier) plus health signals for last preview, last completed cleanup and unapplied preview candidates; the proposed service-identity model is specified. | No scheduler and no service identity exist; no unattended run was built (D7). |
| 44 | Reliability / safeguards | **Partial** | Health signals (earlier) plus drill evidence checked against real exports (the database sets a match flag) and a rule that archive drills can never pass. | No real restore drill is recorded; provider backup/PITR status is never read (D8). |

## Wording that must not be used

- "Full parity", "backup", "recovery proven" or "restored": the export is an archive and no restore drill has been recorded.
- "Delivered" or "read" for WhatsApp: statuses are a person's report and no provider exists.
- "Profit", "ROI of a campaign" or "accounting" for the marketing return or the cash position.
- "Scheduled" or "automatic" for cleanup: consent can be recorded but nothing runs it.
- "Verified invitations" for access: invitation delivery and real sign-in were never tested.

## Rows carried from the previous proposal

#2 to #30, #32, #33, #35 to #37, #40 and #42 stay as accepted: Implemented. Their live-workflow QC items from the 1 October "owner QC priorities" still apply.
