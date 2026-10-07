# Assignment 14 — organization backup and restore manifest (#38)

Implement at most two features:

1. An owner-authorized asynchronous or bounded export that produces a manifest plus organization-scoped table data and a complete listing of organization-owned Storage objects/configuration.
2. A restore verifier/dry-run tool that validates archive version, migrations, tenant IDs, row counts, hashes, and missing files without changing production.

Do not call this a backup unless a disposable-project restore is demonstrably possible. Never include Auth secrets, service keys, other organizations' rows, signed URLs, or transient tokens. Large exports must be bounded/streamed and auditable. Provide a versioned format and explicit unsupported tables/files. Test cross-tenant isolation, interrupted export, hash mismatch, archived objects, and formula-safe tabular data.

