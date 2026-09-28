# Handoff: Section 35 — Retention and renewal

## Status and implementation SHA

**Complete.** All automated gates pass (typecheck, lint, `run_all_gates.sh`
GATE 1-8, batch1a, batch1b, the new S35 SQL behavioral suite,
`migration_upgrade_replay.sh`). Browser verification covers the owner role,
the groomer (no-membership-access) role, a real end-to-end renewal through
the focused deep link, threshold persistence across reload, and a mobile
viewport. One real production bug was found live in the browser and fixed
(F11 — see the evidence table). See "Genuine remaining limits" for the
precise, honest boundary of what was and was not exercised.

Baseline SHA (branch point): `bbdffb9eb3563fe5f4c884c5cf186c05522d41aa`
(sections 23-26 Codex closeout). Worktree: `E:\Claude\operro-retention-s35`.
Branch: `claude/section-35-retention-renewal`.

## Requirement-to-existing-code map

| Requirement | Reused from | Notes |
|---|---|---|
| Renewal preview/pricing/fingerprint | `app.preview_package_renewal`, `previewPackageRenewalAction` | Already gated on `membership.read` only -- no weakening needed. |
| Renewal mutation | `app.renew_customer_package`, `renewCustomerPackageAction`, `MembershipManager` | Gated on `invoice.issue` + `membership.manage`. Reused unmodified; deep-linked via a new `focusMembershipId` prop, not forked. |
| Membership row shape / mutable-field remount key | `apps/web/src/lib/membership-admin.ts`, `membership-filter-list.tsx` | Preserved. |
| Correction form date semantics | `apps/web/src/lib/membership-correction.ts`, `timezone.ts` | Reused as-is; not modified. |
| Calendar-day math in business timezone | `zonedDaysBetween`, `zonedDayISO` (`timezone.ts`) | Reused directly in TS; SQL side uses the equivalent `(x at time zone 'Asia/Jakarta')::date` subtraction. |
| WhatsApp link + encoding | `buildWhatsAppUrl` (`customer-360.tsx`) | Reused unmodified; confirmed live in the browser (F14). |
| Org-level settings storage | `organizations.settings` jsonb | New `followup_retention` sub-key via safe `jsonb ||` merge, other keys untouched (proven live and in SQL, F12). |
| Settings write permission | `settings.manage` (already seeded) | Added to `CAPABILITY_KEYS` in `authorization.ts` (was missing from the TS allow-list). |
| Audit trail for settings writes | `app.audit_log`, explicit insert in `update_followup_retention_settings` | A generic trigger on `organizations` was tried first and reverted; it broke the seed script -- see "Errors and fixes." |
| Tenant/branch authorization | `app.assert_tenant_authorized`, `app.has_branch` | Reused inside the two new RPCs; no bypass. |
| Last-groomed source of truth | `grooming_job_pets` (status), `bookings` (timing) | Fixed a real bug: old loader required `bookings.status='completed'` (whole booking), hiding a pet individually `complete` while a sibling pet on the same booking is not. Added `grooming_job_pets.completed_at` since `updated_at` is re-stamped on any later edit. |
| One-off vs recurring package | `packages.recurrence_interval` (`'none'` = token) | Confirmed live on real seed data -- both existing HomePaw Demo packages are one-off tokens, correctly excluded from "Perlu tindakan" by default. A real recurring membership was created and sold live to prove the actionable path (see F10). |
| Held / available / consumed | `customer_packages.sessions_remaining` + `package_reservations` + `customer_package_ledger` | Same formula as `preview_package_renewal`; consumed derived from the ledger. |

## Exact permission mapping

| Action | Permission required | Where enforced |
|---|---|---|
| View overdue-pet queue | `booking.read` (+ modules `crm`, `scheduling`) | `app.list_overdue_customers`; also gated in `/followups/page.tsx` before the loader runs |
| View renewal queue | `membership.read` (+ module `membership`) | `app.list_renewal_queue`; also gated in `/followups/page.tsx` |
| Change inactivity threshold / templates | `settings.manage` | `app.update_followup_retention_settings` |
| Price a renewal (preview) | `membership.read` | `app.preview_package_renewal` (pre-existing, unmodified) |
| Issue a renewal invoice | `invoice.issue` + `membership.manage` | `app.renew_customer_package` (pre-existing, unmodified) |
| Branch-scoped visibility | `branches.all`, else `membership_branch_access` grant | `app.has_branch`, inside `list_overdue_customers` for both `p_branch` and the visit/upcoming joins |

## F01-F15 evidence table

| ID | Result | Evidence |
|---|---|---|
| F01 | PASS | SQL log: "F01 30-day pet included" / "F01 29-day pet excluded" |
| F02 | PASS | SQL log: "F02 00:30 Jakarta completion counts as exactly 1 day, got 1" |
| F03 | PASS | SQL log: both F03 assertions |
| F04 | PASS | SQL log: "F04 one visit with two service lines yields exactly one pet entry, got 1" |
| F05 | PASS | SQL log: all 5 F05 assertions |
| F06 | PASS | SQL log: both F06 assertions |
| F07 | PASS | SQL log: all 5 F07 assertions (available=0/held=2/consumed=2) |
| F08 | PASS | SQL log: all 9 F08 assertions |
| F09 | PASS (SQL + JS contract) | SQL log F09 assertion (a canceled membership's own preview reports `blocking_reason`); JS test asserting `canCombine` requires zero errored previews before a combined total is shown. Not reproduced live with two real memberships, one genuinely blocked, selected together in one draft (only a single-membership live draft was exercised). |
| F10 | **PASS (browser, real end-to-end)** | Created a real recurring package ("S35 Monthly Membership", 4 sessions/Rp400.000/monthly) in the catalog, sold it to a real seeded customer (Cynthia Tan) via the existing invoice flow, then renewed it through the focused `?membershipId=` deep link from the renewal queue: exactly one invoice (`PKR-20260928-81B6DE12`), submit button correctly disabled after success (mutable-field remount fix intact), "Kembali ke antrean" returned to a queue with refreshed balance (4/4 sessions). A combined-customer message draft was then built from a **real fetched preview** (`previewPackageRenewalAction`), correctly showing `Rp 400.000`. Double-click/retry and a stale-preview submit were not separately reproduced live this round; `renew_customer_package`/`renewCustomerPackageAction` are unmodified and already proven for those cases in the S23-26 closeout. |
| F11 | **PASS, one real bug found and fixed live** | SQL: all F11 assertions (read-only membership.read role, branch-restricted role, zero-permission role, cross-org, no-membership-at-all). **Browser, as `groomer@homepaw.local`** (booking.read/update/complete only -- no membership.read, no settings.manage): overdue tab correctly showed real data with no settings button; **renewal tab crashed the whole page** (`Error: renewal_queue_failed:missing_permission:membership.read` reaching an unhandled Next.js error boundary) instead of an explicit restricted state. **Fixed** in `apps/web/src/app/followups/page.tsx`: both tabs now check `booking.read`/`membership.read` explicitly before calling either loader, rendering "Tidak memiliki akses" otherwise -- matching this codebase's own documented convention in `authorization.ts`. **Re-verified live after the fix**: reloading `/followups?tab=renewal` as the groomer now shows "Tidak memiliki akses -- Anda memerlukan izin membership.read untuk melihat antrean perpanjangan membership," no crash; the overdue tab still renders correctly for the same role. Covered by a new JS contract test asserting the gate runs before the loader call. |
| F12 | PASS | SQL log: all 3 F12 assertions + 4 validation rejections. Also live: threshold changed 14 -> 5 -> 1 across real page reloads (owner role), persisted correctly each time. |
| F13 | PASS | SQL log: all 4 F13 assertions (1104 total groups, page-size-100 pagination, final page reachable, large-single-customer-group truncation count). |
| F14 | PASS (SQL + browser) | SQL log: special-character customer name (`Cust F14 O'Brien & Co` + emoji) and a malformed phone preserved verbatim. Browser: a real draft for customer "Cynthia Tan" / pet "Bubu" produced correct interpolation and a correctly-encoded `wa.me` URL (`https://wa.me/6281210000301?text=...`); the clipboard-copy failure path was exercised live (this sandboxed browser blocks `navigator.clipboard`), showing the designed fallback message rather than a false success. |
| F15 | PASS (live, partial) | Threshold save+reload persistence confirmed live twice (5 -> reload -> 5; 1 -> reload -> 1). **Org switch was attempted but the seeded owner account has only one organization** (`/organizations` auto-redirects straight to the dashboard), so a second/empty-organization view could not be reached live with the available seed data -- tenant isolation itself is separately proven in SQL (F11's cross-org assertions, real RLS/RPC authorization, not a service-role shortcut). Mobile viewport (375x812) checked on both tabs: no horizontal overflow, filters/buttons wrap and remain usable; one minor cosmetic note -- on the renewal tab, the search input and the "Tampilkan token sekali pakai" checkbox share a row and the input's placeholder text truncates at this width (still fully functional, not a blocking issue, not required by any specific F-item). |

## Errors and fixes (this session)

- **`organizations` audit trigger broke the seed script.** First attempt attached the generic `app.tg_write_audit` trigger to `organizations`. `app.fn_active_organization()` returns NULL outside an authenticated session, violating `audit_log.organization_id`'s NOT NULL constraint during seeding. Fixed with an explicit `app.audit_log` insert inside `update_followup_retention_settings` itself.
- **Docker/WSL transport instability**: the PG16 gate container, and separately this worktree's own Supabase stack, were repeatedly observed to stop or restart between *separate* tool invocations even though stable within one continuous script; container auto-restarts were also observed independent of any command this session issued (likely host/Docker Desktop resource contention, given ~40 containers were running concurrently across this machine's several worktree stacks). Fixed the gate/test runs by wrapping each in a single shell script (`docs/handoffs/logs/S35/run_*.sh`) that starts/verifies the container and runs the actual test in one uninterrupted process. For final shutdown, stopped this worktree's Supabase containers by exact name (`docker stop supabase_*_operro-retention-s35-local`) rather than `supabase stop`, after discovering that running `supabase stop` concurrently with reverting `supabase/config.toml` raced and caused it to resolve the wrong project id.
- **`psql`/`createdb`/`dropdb` wrappers didn't pass `PGUSER`/`PGPASSWORD`** into the container (`docker exec` doesn't inherit env), defaulting to OS user `root`. Fixed with explicit `-e PGUSER=postgres -e PGPASSWORD=postgres`.
- **GATE 8 needs `/tmp` bind-mounted** (its concurrency harness references host temp paths through the `psql` wrapper). Fixed with `-v /tmp:/tmp`.
- **Real SQL smoke-test bugs found while iterating** (all in the new test file, none in the migration): malformed UUIDs using invalid hex letters; a stale-planner-statistics slowdown after a 2200-row bulk insert (fixed with explicit `ANALYZE`, matching what a real deployment's autovacuum would already have done for organically-grown data); a fixture double-counting `sessions_remaining` against the ledger-apply trigger; a fixture referencing `bookings.pet_id`, a column a prior migration (20260721001300) already dropped; a search-term fixture mismatch; and a test-methodology fix for F12 (Postgres freezes `now()` for a whole transaction, so two sequential writes can't be told apart by timestamp within one script -- restructured to prove the guard's actual contract instead of depending on wall-clock advancement).
- **Real production bug found live in the browser (F11)**: the renewal tab crashed instead of denying gracefully for the groomer role. Fixed and re-verified live -- see F11 row above.

## Cross-engine migration note (out of S35 scope, flagged per explicit request)

While finishing this closeout, a file **not created by this branch** was
found sitting untracked in this worktree:
`supabase/migrations/20261012100000_invoice_number_random_suffix.sql`,
along with matching uncommitted edits to `integration/invoice_parity_smoke.sql`
and `run_all_gates.sh`. These were **reverted from this worktree's tracked
files** (`git checkout --`) before the final commit below and are **not
part of this branch** -- S35 does not touch invoicing. The untracked
migration file itself was left on disk (not deleted, since it was not
created by this session and its purpose there is unclear) but was not
staged or committed.

Investigation (`git log --all -- supabase/migrations/20261012100000_invoice_number_random_suffix.sql`)
found this exact filename independently committed on **two different
engine branches**:

- `claude/sections-27-30-documents-payments-visits` (Engine 2), commit
  `eca7bb3` -- "Fix: invoice_number can collide on back-to-back issuance
  (UUIDv7 timestamp prefix)". Also touches `package.json` (+5 lines,
  unrelated win32-binary fix) and `integration/invoice_parity_smoke.sql` /
  `run_all_gates.sh` (adds the new migration to the gate's expected list).
- `claude/sections-32-33-payroll-exports` (Engine 3), commit `cb42478` --
  "Apply invoice number suffix fix through forward migration". Same new
  migration file and the same `integration/invoice_parity_smoke.sql` /
  `run_all_gates.sh` additions, but **additionally edits the already-applied
  migration `20260924140000_invoice_discounts_charges.sql` in place**,
  reverting an apparent prior direct edit of that file's
  `issue_invoice_for_booking` function back to its original (buggy,
  `substr(...,1,8)`) text -- restoring that historical migration to match
  what was actually applied, while the real fix lives in the new forward
  migration (correct practice; editing an *already-applied* migration
  directly is otherwise the wrong way to ship this kind of fix).

**The new migration file itself (`20261012100000_invoice_number_random_suffix.sql`)
is byte-for-byte identical between the two branches** (`diff` confirms zero
difference), as is the `integration/invoice_parity_smoke.sql` addition and
the `run_all_gates.sh` line. **The only real differences are each branch's
own unrelated extra change** (Engine 2's `package.json` fix; Engine 3's
cleanup of the pre-existing direct edit to `20260924140000`).

**Recommendation for integration**: because the new migration's filename,
timestamp, and content are identical on both branches, applying it via
*either* branch's merge is sufficient -- the second branch's copy of that
one file should be dropped (not re-applied) when merging, to avoid a
redundant `create or replace` (harmless on its own, since the function body
is identical, but a needless duplicate migration file). Engine 2's
`package.json` change and Engine 3's `20260924140000` cleanup are each
real, non-duplicate changes and should both be kept from their respective
branches. This branch (S35) does not need this migration at all and does
not include it.

## Changed-file map

- `supabase/migrations/20261002090000_retention_renewal_followups.sql` (new)
- `run_all_gates.sh` (added the new migration to `EXPECTED_MIGRATIONS`)
- `apps/web/src/lib/authorization.ts` (`settings.manage` added to `CAPABILITY_KEYS`)
- `apps/web/src/lib/followup-retention.ts` (new)
- `apps/web/src/lib/followup-messages.ts` (new)
- `apps/web/src/app/followups/actions.ts` (new)
- `apps/web/src/app/followups/page.tsx` (rewritten; includes the F11 permission-gate fix)
- `apps/web/src/app/programs/memberships/page.tsx` (deep-link support)
- `apps/web/src/components/followup-settings-panel.tsx` (new)
- `apps/web/src/components/overdue-queue.tsx` (new)
- `apps/web/src/components/renewal-queue.tsx` (new)
- `apps/web/src/components/membership-filter-list.tsx` (focus-row support)
- `apps/web/src/components/membership-manager.tsx` (`autoExpand`/`returnTo` props only)
- `apps/web/test/followup-retention-contract.test.ts` (new, 28 assertions, in `test:batch1b`)
- `integration/retention_renewal_followups_smoke.sql` (new, F01-F14 SQL tests)
- `docs/handoffs/logs/S35/*.sh` and `*.log` (test-runner scripts and raw output, kept as evidence)

Migration order: newest in the repository (`20261002090000`), after Engine 1's own `20260927090000`. Not related to, and does not include, the separate `20261012100000` invoice-number migration discussed above.

## Reproduction sequence

From `E:\Claude\operro-retention-s35`:

```bash
npm install
npm run typecheck -w apps/web
npm run -w apps/web lint
npm run test:batch1a -w apps/web
npm run test:batch1b -w apps/web
bash run_all_gates.sh
```

```bash
psql -v ON_ERROR_STOP=1 -f integration/retention_renewal_followups_smoke.sql
bash integration/migration_upgrade_replay.sh
```

Browser verification: `supabase start` in this worktree (temporarily sets
`supabase/config.toml` to ports 54361-54364 -- **reverted after this
session's verification, not part of the committed state**),
`apps/web/.env.local` -> `http://127.0.0.1:54361` with the publishable key
`supabase start` prints, `npm run dev -w apps/web`, sign in as
`wbudiman1995@gmail.com` / `operro-local-qa` (owner) or
`groomer@homepaw.local` / `operro-local-qa` (no membership access).

## Raw log index

- `docs/handoffs/logs/S35/run_all_gates.log` -- `ALL GATES PASSED`, exit 0
- `docs/handoffs/logs/S35/retention_renewal_followups_smoke.log` -- full F01-F14 SQL suite, final `smoke test exit=0`
- `docs/handoffs/logs/S35/migration_upgrade_replay.log` -- `FOLLOW-ON MIGRATIONS AND COMPLETE LIFECYCLE SMOKE PASSED`, exit 0
- `docs/handoffs/logs/S35/run_gates_via_pg16_container.sh`, `run_smoke_test.sh`, `run_upgrade_replay.sh` -- exact transport scripts used

## Integration notes for Engines 2/3

Not touched: `E:\Claude\operro-sections-27-30`, `E:\Claude\operro-payroll-s32-s33`,
their branches, worktrees, containers, or databases. This worktree's local
Supabase stack used its own isolated ports (54361-54364) and project id
(`operro-retention-s35-local`) during verification, confirmed not colliding
with the other engines' running stacks, and was fully stopped afterward.
Exactly one new, uniquely-timestamped migration is included in this branch.
See the "Cross-engine migration note" above for a separate, unrelated
finding about Engines 2 and 3 sharing an identical migration filename.

## Genuine remaining limits (reported plainly)

- **No seeded role holds `membership.read` without `membership.manage`.** This exact case was proven in SQL (F11) but not driven through a live login, because no such user exists in the seed data and creating one was judged out of scope for this module. The groomer role tested live has neither permission -- a stronger, different denial case, not a substitute.
- **Org switch to a second/empty organization could not be exercised live** -- the seeded owner account has only one organization available. Tenant isolation is proven thoroughly in SQL via real RLS/RPC authorization (F11's cross-org assertions), not by a UI observation.
- **A genuinely blocked/errored preview inside a multi-select combined renewal draft** (F09's core interaction) was proven in a JS contract test and via the RPC correctly reporting `blocking_reason` for a canceled membership (SQL), but not reproduced live with two real memberships selected together, one of them genuinely blocked.
- **Double-click/retry and a stale-fingerprint submit were not independently reproduced live** for the S35 deep-link path specifically; the underlying idempotency and fingerprint guarantees are unchanged from the S23-26 closeout, which did prove them live, and `renew_customer_package`/`renewCustomerPackageAction` were not modified by this branch.

None of the above are known failures -- each rests on an equivalent SQL/contract proof or unmodified, previously-proven code. Listed precisely rather than folded into a blanket "done," per the brief's own instruction that a passing build does not prove a UI works.
