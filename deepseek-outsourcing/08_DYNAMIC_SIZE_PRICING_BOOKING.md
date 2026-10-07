# Assignment 08 — dynamic bands in catalog and booking (#21, phase 2)

Prerequisite: Codex has integrated Assignment 07 and supplied a refreshed bundle.

Implement at most two features:

1. Catalog management for creating, renaming, reordering, and archiving tenant size bands, with explicit price/duration configuration per service.
2. Booking/pet classification and invoice-line assembly using stable band IDs and immutable label/price/duration snapshots.

Do not touch package/payroll behavior beyond compatibility required to keep it functioning; that is Assignment 09. Refuse destructive operations when they would make active catalog/booking inputs invalid. Test concurrent edits, overlapping boundaries, archived bands, new XXL classification, existing XS–XL equivalence, and historical invoice immutability.

