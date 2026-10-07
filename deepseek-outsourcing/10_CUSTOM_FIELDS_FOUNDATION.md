# Assignment 10 — custom-field definitions (#40, phase 1)

Implement only the foundation for owner-configurable customer and pet fields.

Support a deliberately small set of types proven useful by HomePaw (for example short text, number, date, yes/no, and single select). Create tenant-owned field definitions with stable IDs, entity scope, label, type/options, ordering, active/archive state, and validation. Store values in a design that supports RLS, export, and future editing without allowing arbitrary executable expressions or unbounded JSON.

Build the owner definition editor and server/RLS tests. Do not yet add fields to onboarding, Customer 360, search, or exports; those belong to Assignment 11. Provide a migration/backfill strategy for any scalar metadata currently displayed as custom fields.

