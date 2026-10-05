# Claude assignment — dynamic size bands, Bundle 1 DB foundation

Base: `d4ee76d4882ca4b4c73524c4fea175f9a669f81b` on `codex/parity-orchestration`.

Read first:

- `docs/agent-work/CLAUDE-DYNAMIC-SIZE-DESIGN-RESPONSE.md`
- `apps/web/AGENTS.md` (informational for this DB-only bundle)
- the current migration and integration sources cited by the design response

## Objective

Implement and verify only the database foundation for parity item #21. Do not build management RPCs, application adapters, catalog UI, booking UI, package UI, invoice UI, or payroll changes in this assignment.

Use these exact migration slots:

1. `supabase/migrations/20261023100000_size_band_tables.sql`
2. `supabase/migrations/20261023110000_size_band_shadow_sync.sql`
3. `supabase/migrations/20261023120000_size_band_resolver.sql`
4. `supabase/migrations/20261023130000_size_band_integrity.sql`

## Product rulings

Treat these as decided, not open:

1. Keep `cat` as the permanent non-weight pseudo-band row.
2. Preserve Operro's boundary semantics: exactly `25.00 kg` remains `large`; `25.01 kg` is `extra_large` under the default layout.
3. Preserve exact package-band matching. Do not implement HomePaw's larger-token-covers-smaller behavior.
4. Payroll will ultimately use the Basic Grooming line's immutable band snapshot for new draft computations, with live-pet fallback only when historical data has no usable line snapshot. Do not implement payroll in this bundle, but do not design Bundle 1 in a way that prevents this.
5. Generate immutable band keys server-side from labels; owners will not edit keys directly. Key-generation RPC work belongs to Bundle 2.
6. Maximum is 12 active dog-weight bands per organization; `cat` does not count.
7. Re-band weighted dogs automatically after an accepted layout change. Refuse archive when a weightless/manual-size dog still uses the band.
8. Do not add size to invoice or payslip PDFs in this parity item. Payroll CSV/XLSX label/key work remains in Bundle 4.
9. Weight ranges must remain a contiguous partition; no gaps or unsized ranges.
10. A platform owner may manage a tenant only while that tenant is the active/selected organization context. Never allow an arbitrary cross-tenant `p_org` edit. Preserve the helper-role refusal.
11. Dynamic-mode activation is platform-controlled for the initial rollout. Business owners may manage bands only after their organization has been activated. The mode-switch RPC itself is Bundle 2.
12. Keep legacy mirror columns for at least two releases; no SB-99 work now.

## Required implementation

Implement SB-01 through SB-04 from the design response, with these refinements:

- Forward-only migrations only. Do not edit any existing migration.
- Preserve the five legacy keys and `cat` exactly.
- Backfill every organization, including soft-deleted organizations.
- Keep organizations without a boundary row behaviorally equivalent to defaults `5/10/15/25`.
- Store an explicit `upper_inclusive` flag so the legacy `large <= 25` quirk survives.
- Ensure the schema enforces both at most one and at least one open-ended active dog band. A partial unique index alone is insufficient; the deferred layout validator must enforce the full partition at commit.
- Make `band_key` immutable.
- Use composite tenant-safe foreign keys wherever the design calls for them.
- Keep historical grooming line snapshots free-form/regex-validated; do not attach them to an active-band FK.
- Make all new tenant tables RLS-enabled. Members may read only their active organization; `anon` cannot read; no direct authenticated DML grants.
- Harden every new `SECURITY DEFINER` function with an empty or pinned `search_path`, revoke execution from `public`, and grant only the required role.
- In legacy mode, the old boundaries and the 12 legacy catalog columns remain authoritative and shadow-sync into the new tables.
- Redefine the authoritative resolver and `assembly_add_line` without changing the public function signature or existing SQLSTATE/error-code behavior.
- Replace fixed pet/package checks with tenant-safe referential integrity only after a preflight that reports offending organization and row identifiers. Do not rewrite existing values.
- Replace fixed pet-size allowlists in the current `create_customer_household` and onboarding function definitions with active-band lookups and friendly existing-domain errors.
- Preserve zero-minute service behavior, custom-species pricing behavior, package redemption semantics, immutable invoice/line snapshots, and sold-package locks.

## Tests and gate work

Add and run the smallest rigorous proof for this bundle:

- Update `run_all_gates.sh` migration inventory for the four assigned migrations.
- Add `integration/size_band_smoke.sql` covering fresh seed/backfill, RLS, legacy equivalence, the `25.00/25.01` edge, resolver price/duration parity, custom species, zero-minute add-ons, package sale/renewal behavior, and rejection of invalid layouts/direct writes.
- Add shared golden vectors at `integration/size_band_golden_vectors.json` if practical in this bundle; otherwise put the equivalent exhaustive boundary vectors in SQL and explain why JSON is deferred to the TypeScript bundle.
- Extend `integration/homepaw_size_membership_smoke.sql` only where needed to prove unchanged behavior.
- Extend `integration/run_populated_upgrade_rehearsal.sh` with preservation hashes/counts for pets, snapshots, packages, prices, durations, invoices, and published payroll data.
- Add the existing platform-access smoke to `run_all_gates.sh` only if it can run deterministically in the same disposable-stack contract; otherwise document the exact blocker rather than weakening it.
- Do not add Bundle 2 management/concurrency tests for RPCs that do not exist yet.

Run, at minimum, all repository gates affected by the migration lineage and report exact commands and results. A source-text regex test is not behavioral proof.

## Stop conditions

Stop and report instead of guessing if:

- existing data contains off-list pet/package keys that make the intended FK migration unsafe;
- the current applied function signatures or grants cannot be preserved;
- a required test needs production/shared Supabase access;
- an unrelated dirty-worktree change overlaps a file you must edit;
- preserving legacy behavior conflicts with a product ruling above.

Do not deploy, touch production/shared data, implement UI, or begin Bundle 2.

## Return

Return:

1. concise implementation summary;
2. exact files changed;
3. migration/data-preservation reasoning;
4. exact test commands and pass/fail results;
5. any residual risks or deferred Bundle 2 work;
6. the resulting commit SHA if you commit, otherwise say explicitly that you did not commit.
