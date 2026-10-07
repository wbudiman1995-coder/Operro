# Assignment 11 — custom fields in CRM and export (#3, #40, phase 2)

Prerequisite: Codex has integrated Assignment 10 and supplied a refreshed bundle.

Implement at most two integrations:

1. Render/edit validated custom-field values in Customer 360 and pet editing.
2. Include active definitions/values in CRM export without formula injection or cross-tenant leakage.

If public onboarding is included, it must be explicitly enabled per field and enforce the same validation through narrow token-scoped RPCs; otherwise document it as deferred. Test type validation, archived definitions, option changes, tenant isolation, formula-like export values, and old records without values.

