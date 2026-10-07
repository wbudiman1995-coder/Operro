# Assignment 07 — dynamic size-band foundation (#21, phase 1)

Implement only the database/domain foundation for tenant-owned dog size bands. Do not build the final UI or switch financial calculations yet.

Inventory every fixed XS/S/M/L/XL key in pricing, booking, package eligibility, payroll, forms, and tests. Design a forward migration that introduces ordered, tenant-owned stable band IDs/keys, migrates existing boundaries, preserves current behavior, and provides immutable snapshots for future financial records. Existing data must remain byte/semantically equivalent where appropriate.

Add tenant/RLS constraints, ordering/overlap validation, and a compatibility adapter so existing reads still work during staged migration. Provide fresh and populated-upgrade PostgreSQL 16 tests. The handoff must enumerate every remaining call site for phases 2 and 3. No add/delete buttons yet.

