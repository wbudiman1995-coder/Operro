# Assignment 02 — narrow CRM bulk edit (#2)

Implement one feature: the smallest useful HomePaw-style bulk edit over existing mutable customer fields.

First identify the exact HomePaw bulk behavior and Operro fields already supported. Select one coherent operation, such as updating an existing acquisition source, service area, or another already-authoritative field; do not introduce a generic bulk mutation framework. Require `customer.manage`, resolve the active organization server-side, cap batch size, validate every selected customer belongs to the organization, update atomically, and write audit/timeline evidence.

Add a minimal selection/action UI to the existing CRM. Test all-or-nothing failure, unauthorized use, cross-tenant IDs, empty/oversized batches, and successful audit output. Do not alter invoice/booking snapshots.

