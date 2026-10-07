# Claude Code correction — Bundle 2 is not accepted

Continue in the existing `dynamic-size-bundle-2` worktree. Its current head is `c2b2ed2`, based on `5d454fe`. Do not touch the main checkout or rewrite Bundle 1 migrations/tests. Read the complete original assignment at:

`C:/Users/DW_wi/Documents/ChatGPT/Operro/docs/agent-work/CLAUDE-DYNAMIC-SIZE-BUNDLE-2.md`

The current two commits are rejected. Correct them with follow-up commits; do not merely explain the defects.

## Verified failures

1. `npm exec --workspace apps/web -- tsx --test test/size-bands.test.ts` fails because the repository does not contain `vitest`. Use `node:test` and `node:assert/strict`, matching existing tests.
2. ESLint fails in `size-band-editor.tsx` with conditional Hooks after an early return, an unused import, and unescaped JSX text.
3. `SizeBandEditor` is unused. No catalog page/action, service matrix, starter, package, loader, or pilot-action file imports the new component/library. The required Bundle 2 UI and server-action integration is absent.
4. The SQL test is not executable: it references `public.auth.users`, assigns text status/mode into an integer, assigns a UUID into JSONB, bypasses the mode RPC with direct writes, and does not test real authenticated/anon roles.

## Migration defects that must be fixed

The current SB-05 migration is unsafe and incomplete. Replace its implementation inside the same new migration file; do not edit SB-01…SB-04.

- Preserve the exact existing `app.set_dog_size_boundaries` signature, named arguments, grants, behavior, and established error codes. Inspect `20261019110000_org_dog_size_boundaries.sql` and all call sites first. The current replacement drops `p_org` and references nonexistent `xs_upper_kg`/`s_upper_kg`/`m_upper_kg`/`l_upper_kg`; the real columns are different.
- Server-side key generation is mandatory. New-band keys must come from labels on the server with deterministic collision handling. Owners must never supply/edit keys. Preserve immutable keys for existing rows.
- Preview must calculate actual measured-dog reband counts and active-entitlement/package mismatches against the proposed layout. Save must use the same calculation and refuse mismatches atomically.
- Save must validate the full layout, detect a true no-op without bumping the version, lock the settings row, bump exactly once for a real change, re-band measured dogs in the transaction, and write the existing audit mechanism. It must not rewrite historical snapshots.
- Archive must validate `p_expected_version`, bump the version, preserve a valid contiguous layout/open top, re-band measured dogs, and refuse cat/last-band/manual-pet/sellable-package/active-entitlement dependency cases.
- Delete must take the expected version and refuse every reference listed in the original assignment, including soft-deleted pets/packages, entitlements, historical/voided grooming-line snapshots, payroll matrices, and nonempty service price/duration rows. Return structured reasons.
- Service price writes must validate JSON shape, service/active-org ownership, active band keys, nullable nonnegative price/duration, capability, and mode-compatible legacy mirroring. Implement the required copy-from-previous behavior through the application UI without trusting client organization IDs.
- Mode switching is platform-owner-only for the active tenant, optimistic/versioned, audited, and rollback-safe. A dynamic layout not exactly representable by the legacy five must raise `rollback_blocked_custom_bands`; a valid rollback must synchronize legacy boundaries/prices first.
- All management functions must use `SECURITY DEFINER`, `search_path=''`, explicit revoke/grant, organization status checks, active-organization derivation, correct capability/owner/helper-role denial, settings locks, and expected-version concurrency as required by the assignment.
- Do not use direct table mutations in behavioral tests to stand in for RPC authorization or mode switching, except controlled superuser fixture setup before switching into real roles.

## Application work still required

Implement every bounded Bundle 2 application surface from the original assignment:

- real route-local server actions in `/catalog` for preview/save/archive/delete/mode/price operations;
- server-side loading of settings, active/archived bands, ranges, and service-band prices;
- legacy mode continues to render `DogSizeBoundariesForm`;
- dynamic mode renders the editor only to the authorized owner/platform owner;
- platform-controlled mode UI/action;
- service and duration matrices iterate organization bands, preserving custom species separately;
- HomePaw starter, service manager, package forms/managers, pilot data/actions use dynamic options where Bundle 2 requires them while legacy behavior stays unchanged;
- new bands clearly fall back to base price and support copying values from the previous band;
- accessible Indonesian UI at 375 px; no editable/raw band key is shown.

Do not touch Bundle 3 booking/invoice/customer adapters or Bundle 4 payroll computation/export.

## Tests and proof

- Convert TS tests to the repository's `node:test` style and test real integration contracts, not only helpers.
- Replace the malformed SQL test with executable PostgreSQL 16 behavior/RLS tests using `auth.users`, correct types, real `authenticated`/`anon` roles, cross-tenant denial, helper denial, manager-vs-owner authority, direct-DML denial, no-op/version behavior, impact/save equivalence, archive/delete guards, service pricing, mode rollback, and legacy wrapper compatibility.
- Add a real two-session concurrency harness for same-version saves and save-versus-line/package behavior, wired into `run_all_gates.sh`.
- Preserve and run the existing SB-01…SB-04 size-band smoke/preflight/populated-upgrade evidence.

Before committing, run and fix until all pass:

1. focused `node:test` tests;
2. `npm run typecheck`;
3. `npm run lint --workspace apps/web -- --max-warnings=0`;
4. `npm run build --workspace apps/web`;
5. fresh PostgreSQL 16 migration replay plus the new SB-05 behavior/RLS tests;
6. concurrency harness;
7. relevant size-band, platform-access, HomePaw size/package, and populated-upgrade gates;
8. `git diff --check`.

Do not claim a check you did not run. Commit only after the implementation and applicable gates pass. Return the follow-up commit SHA(s), exact commands/results, and any remaining unverified browser QC.
