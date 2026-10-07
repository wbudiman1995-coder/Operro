# Assignment 12 — finance export and cash position (#31)

Implement at most two finance features:

1. Review and adapt the finance XLSX export represented by `reference/ops-quickwins.patch` if present; otherwise implement it by reusing the existing filtered payment-register and expense loaders. Export filters must match the screen and spreadsheet cells must resist formula injection.
2. Add a read-only cash-position summary from authoritative payments, refunds, and expenses, separated by currency and period. Do not create an accounting ledger unless HomePaw proves one exists and requirements are complete.

Require `finance.read`, derive the organization server-side, and test pagination completeness, filters, mixed currencies, refunds, formula-like text, empty data, and tenant isolation. Do not mutate financial history.

