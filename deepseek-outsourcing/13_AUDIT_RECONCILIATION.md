# Assignment 13 — cross-entity audit and read-only reconciliation (#36, #37)

Implement at most two features:

1. A cross-entity audit viewer using the existing audit RPC/data, with understandable action/entity labels, actor resolution, filters, and changed-field summaries. Review `reference/ops-quickwins.patch` for reusable invoice audit work.
2. A read-only operational discrepancy report for completed visits without a valid non-void invoice, issued invoices whose valid payments do not reconcile to balance, and published payroll items whose source was later voided/missing.

The reconciliation report must never auto-repair or invent financial history. Require appropriate read capabilities, scope all sources to the active organization/branches, paginate, and make reasons explicit. Test clean and broken fixtures, cross-tenant rows, voids/refunds, mixed currencies, and snapshot/source deletion edge cases.

