# Assignment 05 — dashboard comparison and configurable cards (#1)

Implement at most two dashboard features:

1. Current-period versus previous-equivalent-period comparison for existing authoritative metrics.
2. Per-business dashboard card visibility using existing settings infrastructure.

Match HomePaw's period definitions and timezone behavior. Do not invent a separate analytics database. Aggregate tenant-scoped source data and preserve currency separation. Card visibility must be a business setting managed by an authorized owner, not a browser-only preference.

Test Jakarta/month boundaries, empty periods, mixed currencies, tenant isolation, permission checks, and settings persistence. Acquisition ROI is explicitly deferred to a separate product-definition pass unless the supplied reference has a complete authoritative cost/source model.

