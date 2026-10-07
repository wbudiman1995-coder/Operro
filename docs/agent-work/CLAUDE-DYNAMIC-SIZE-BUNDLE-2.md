# Claude Code assignment — dynamic size bands, Bundle 2 management and catalog UI

Base: `5d454fe` on `codex/parity-orchestration`.

Work in a separate branch or worktree based exactly on that commit. Preserve the CRM bulk-edit commit and the already integrated Bundle 1 commit `8758cff`. Do not modify, rename, squash, or replace any of these applied migrations:

- `20261023100000_size_band_tables.sql`
- `20261023110000_size_band_shadow_sync.sql`
- `20261023120000_size_band_resolver.sql`
- `20261023130000_size_band_integrity.sql`

Read `apps/web/AGENTS.md` and the relevant installed Next.js 16 documentation before editing application code.

## Objective

Implement only Bundle 2 / SB-05 from the accepted dynamic-size design: safe management RPCs plus the `/catalog` band and price-management UI. This bundle makes the Bundle 1 schema administrable. Booking, invoice, Customer 360, payroll, and end-to-end consumer adapters remain Bundle 3/4 work.

The only new migration slot allocated to this task is:

`supabase/migrations/20261024100000_size_band_management_rpcs.sql`

Do not create any other migration.

## Product rulings already decided

1. `cat` remains the permanent `band_kind='cat'`, `band_key='cat'` row.
2. Preserve Operro boundary semantics: `25.00 kg` remains `large`; `25.01 kg` is `extra_large` in the legacy layout.
3. Package size matching remains exact. Do not implement “larger covers smaller.”
4. Owners never type or edit keys. Generate immutable keys server-side from labels (`xxl`, then a deterministic collision suffix such as `xxl_2`).
5. Maximum 12 active dog-weight bands; `cat` does not count.
6. Weighted dogs re-band automatically after an accepted layout change. Refuse archive when weightless/manual-size dogs still reference the band.
7. Dynamic-mode activation is platform-controlled for initial rollout. A business owner may manage a layout only after the selected organization is already in `dynamic` mode. A platform owner may switch the actively selected tenant between modes. Helper roles must never gain this authority.
8. Legacy mirror columns remain for at least two releases. Do not implement SB-99 retirement.
9. SQL remains authoritative for money, duration, eligibility, keys, authorization, locking, and dependency checks. TypeScript may validate and preview presentation only.

## Required database work

Add SB-05 with these RPCs and compatibility behavior:

- `app.preview_size_layout_impact`
- `app.save_size_bands`
- `app.archive_size_band`
- `app.delete_size_band`
- `app.set_service_band_prices`
- `app.set_size_band_mode`
- redefine `app.set_dog_size_boundaries` as the compatibility wrapper without changing its signature, grants, or established error codes

Every management write must:

- be `SECURITY DEFINER` with `search_path=''`;
- revoke default/public execution before granting only the intended role;
- derive/check the active organization server-side and reject an arbitrary cross-tenant `p_org`;
- require organization status `trial` or `active`;
- lock `organization_size_band_settings` `FOR UPDATE`;
- take `p_expected_version` and raise `stale_layout` on mismatch;
- serialize correctly against Bundle 1's resolver/assembly locks;
- write through the existing audit mechanism with useful before/after payloads;
- preserve historical booking, invoice, package-entitlement, ledger, and payroll snapshots.

Authority:

- Layout preview/save/archive/delete: real business owner of the active organization, but only when mode is already `dynamic`; platform owner is allowed only for its actively selected tenant. A helper/support role is denied.
- Mode switch: platform owner only, actively selected tenant only.
- Service band prices: active-org caller with `service.manage`; no layout authority is implied.
- Direct authenticated/anonymous DML on size-band tables remains denied.

Layout rules:

- `save_size_bands` accepts the full desired active dog layout, validates 1–12 contiguous ordered bands with exactly one open top, creates keys on the server, preserves existing keys, detects no-op replays, and increments `layout_version` only for a real accepted change.
- Preview and save must compute the same impact.
- Refuse a change that would invalidate active measured-dog package entitlements with `active_package_size_would_change` (`23514`).
- After a successful layout change, re-band measured dogs in the same transaction; never rewrite immutable snapshots.
- Archive refuses `cat`, the last active dog band, manual-size pet references, active sellable package definitions, or active entitlement mismatches. Weighted dogs may be re-banded.
- Hard delete requires an archived band and zero references across pets (including soft-deleted), packages (including inactive/deleted), customer-package snapshots, grooming-line snapshots, payroll matrices, and nonempty service price/duration rows. Return structured dependency reasons.
- Legacy rollback is allowed only when the active layout is representable by the legacy five keys; otherwise raise `rollback_blocked_custom_bands`.
- `set_dog_size_boundaries` behaves exactly as before in legacy mode. In dynamic mode it may translate only a legacy-five layout; otherwise raise `use_size_band_editor` (`22023`). Preserve `not_authorized`, `invalid_boundaries`, `organization_unavailable`, and `active_package_size_would_change` behavior.
- Mirror triggers dual-write legacy boundaries and legacy service columns only when the layout remains representable by the legacy five.

## Required application work

Add `apps/web/src/lib/size-bands.ts` with typed band/settings/price models plus pure display validation, range labels, and preview helpers. It must not become an alternate pricing authority.

On `/catalog`:

- Load settings, active and archived bands, derived ranges, and `service_band_prices` tenant-safely.
- Keep `DogSizeBoundariesForm` for legacy mode.
- Render a new accessible `SizeBandEditor` only in dynamic mode and only for an authorized owner/platform owner.
- Support label edits, boundary edits, adding/reordering bands, impact preview, explicit confirmation, archive, and dependency error messages.
- Do not expose editable band keys.
- Explain that a new band falls back to the service base price until prices are entered.
- Offer “copy from previous band” (for example XL → XXL) in the price editor.
- Keep staff/read-only users from seeing mutation controls.
- Make the editor keyboard-usable, usable at 375 px without page-level horizontal overflow, and announce save/errors accessibly.

Replace fixed XS/S/M/L/XL/Cat iteration in the catalog service matrix, service editor, HomePaw starter, package creation/editor, and their data loaders/actions with the organization band list where Bundle 2 requires it. Preserve custom-species pricing separately. Existing legacy-mode behavior and payloads must remain unchanged.

Only touch the bounded Bundle 2 surfaces named in the accepted design:

- `apps/web/src/app/catalog/page.tsx`
- `apps/web/src/app/catalog/actions.ts`
- `apps/web/src/components/dog-size-boundaries-form.tsx` (retain for legacy mode)
- new `apps/web/src/components/size-band-editor.tsx`
- `apps/web/src/components/service-manager.tsx`
- `apps/web/src/components/catalog-price-matrix.tsx`
- `apps/web/src/components/homepaw-service-starter.tsx`
- `apps/web/src/lib/homepaw-starter.ts`
- bounded size-related sections of `apps/web/src/app/pilot-actions.ts`
- `apps/web/src/lib/pilot-data.ts`
- `apps/web/src/components/pilot-forms.tsx`
- `apps/web/src/components/package-manager.tsx`
- new/focused tests and the gate wiring required below

If a necessary change falls outside this list, stop and report it instead of widening scope silently.

## Explicitly out of scope

- Booking wizard, booking actions, invoice studio/workspace, Customer 360, customer/pet forms, payroll computation/settings/export.
- New custom-field work, CRM changes, dashboard changes, finance changes.
- Changing package redemption semantics, renewal billing, ledger behavior, discounts, or historical prices.
- Repricing/recomputing historical bookings or invoices.
- Editing Bundle 1 migrations or their existing assertions merely to make new code pass.
- Deploying or touching production/shared Supabase data.

## Required behavioral evidence

Extend/add focused PostgreSQL tests for SB-05 and wire them into `run_all_gates.sh`. Source-text regex tests are not sufficient.

At minimum prove:

1. Legacy mode remains byte-for-byte compatible, including exact 25.00/25.01 behavior and established error codes.
2. Platform-controlled mode activation and rollback rules.
3. Add a sixth `xxl` band, rename/reorder boundaries, no-op replay, version bump, and measured-dog re-banding.
4. Impact preview equals save impact; active package mismatch is refused without partial writes.
5. Archive/delete dependency guards, including manual pets, sellable packages, soft-deleted rows, historical/voided line snapshots, entitlements, payroll matrices, and service prices.
6. Service price/duration save and copy behavior, base-price fallback, tenant isolation, and manager-vs-owner authority.
7. Real `authenticated` and `anon` role tests for cross-tenant denial, helper-role denial, direct-DML denial, and function grants/search paths.
8. Two-session concurrency for same-version saves and save-versus-line resolution/package sale. Exactly one same-version save may succeed and no torn layout may be observable.
9. Fresh PostgreSQL 16 replay and populated-upgrade preservation; no historical row/value hashes change.
10. Focused TypeScript tests for pure UI helpers, legacy/dynamic rendering contracts, and dynamic package/service option generation.

Run at minimum:

- focused TypeScript tests;
- `npm run typecheck`;
- `npm run lint --workspace apps/web -- --max-warnings=0`;
- `npm run build --workspace apps/web`;
- fresh PostgreSQL 16 migration plus SB-05 SQL/RLS/concurrency tests;
- relevant existing size, package, platform-access, and populated-upgrade gates;
- `git diff --check`.

Do not claim browser verification unless you use a local/disposable authenticated owner and lower-permission session and verify persisted database state. Never use production data.

## Return

Return:

1. findings and any design conflicts;
2. exact files changed;
3. migration and authorization reasoning;
4. exact command/result table;
5. browser checks actually performed and anything not verified;
6. residual Bundle 3/4 work;
7. resulting commit SHA, or explicitly state that no commit was created.

