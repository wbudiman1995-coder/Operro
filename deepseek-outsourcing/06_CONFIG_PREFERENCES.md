# Assignment 06 — business settings and personal preferences (#39, #42)

Implement at most two features:

1. Expose one already-supported but currently hidden HomePaw business setting, chosen after inspecting the schema and reference (for example auto-log visit or notification duration).
2. Add a minimal per-user preference for default landing page or calendar view using an authoritative persisted user-preference row.

Keep organization-owned settings separate from user-owned preferences. Validate allowed routes/views, fail safely when a user loses access, and ensure one user's preference never changes another user's experience. Do not implement language translation in this pass.

Test tenant/user isolation, default fallback, invalid values, revoked access, and owner-only business setting writes.

