# DeepSeek Engine 2 — operations queue

## Supplied snapshot

This packet is a source subset from the Operro working tree on 9 October 2026 (Asia/Jakarta). Codex reviews and integrates all output. Do not deploy, modify production, open a PR, merge branches, create real invoices, or claim tests that were not run.

Read `START-HERE.md`, `operro/apps/web/AGENTS.md`, the parity audit, and the supplied files. Return one patch and one handoff **per task**; wait for `NEXT TASK` before starting another task.

## Important dynamic-size guard

The main checkout has uncommitted payroll-size integration work outside this packet. For Task E2.1, work only from the supplied committed dynamic-size sources. Do not attempt to recreate or overwrite payroll-size integration; identify any remaining payroll gap precisely and stop that part. Codex will reconcile it against the in-progress work.

## Queue

### Task E2.1 — Dynamic size-band completion review (#21)

Audit the supplied dynamic size-band foundation/catalog/booking implementation for gaps in stable identifiers, archiving/deletion guards, historical snapshots, package compatibility, and migration upgrades. Implement only narrow defects that do not touch payroll. Confirm an XXL band can be created and used for new catalog/booking/invoice data while old XS–XL history remains semantically stable. Test tenant isolation, overlap/order validation, active dependency refusal, concurrent edits, and populated upgrades.

### Task E2.2 — Finance export and cash position (#31)

Implement or safely adapt a finance XLSX export from authoritative payment, refund, and expense data, and add a read-only cash-position summary separated by currency and period. Reuse existing filters/loaders and resist spreadsheet formula injection. Require `finance.read`; never mutate financial history or create a new accounting ledger. Test pagination completeness, filters, mixed currencies, refunds, empty data, formula-like data, and tenant isolation.

### Task E2.3 — WhatsApp draft center (#34)

Implement a tenant-scoped queue of existing invoice, follow-up, renewal, and onboarding `wa.me` drafts, plus a user-reported, auditable delivery status log (`draft`, `opened`, `marked-sent`, `failed`, `canceled`). Never auto-send, scrape WhatsApp Web, integrate an unofficial API, or claim provider-confirmed delivery. Test opt-out/missing phone, template variables, idempotency, archived sources, cross-tenant records, permissions, and audit entries.

### Task E2.4 — Cross-entity audit and read-only reconciliation (#36, #37)

Create a bounded, capability-gated audit viewer from existing audit data with useful filters, labels, actor resolution, and changed-field summaries. Add a separate read-only discrepancy view for completed visits lacking valid invoices, issued invoices whose valid payments do not reconcile, and published payroll items whose source was voided/missing. Never auto-repair or invent financial history. Test pagination, branch/organization scope, void/refund/mixed-currency cases, clean/broken fixtures, and deleted-source edges.

## Return format

For each task return: a compact finding table; unified Git patch paths relative to `operro/`; and a handoff with tests/raw results, migration sequence, tenant/security checks, browser-tested/not-tested, limitations, and next task.
