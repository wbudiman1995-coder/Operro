# Engine 3 — Sections 32-33 Payroll & Payroll Exports — Handoff

Single entry point for this engine's work. Updated at every checkpoint.

## 1. Scope

- Section 32: payroll engine (cycles, components, tiers, attendance integration, lifecycle, retention, publication).
- Section 33: payroll exports (XLSX, CSV, payslip PDF).
- Explicitly OUT of scope: section 31 capital/cash, section 34 WhatsApp, bank-account settings, invoice PDFs (Engine 2), package renewal, new visit register.

## 2. Base / branch / worktree

- Main repo: `E:\Claude\operro-local-dev` (WSL: `/mnt/e/Claude/operro-local-dev`)
- Base commit verified: `f820b6b904cffd9d7a24af7e395b8effc327fc06` on `local/design-adoption` — "Integrate invoice workflow, size pricing and discounts"
- Worktree: `E:\Claude\operro-payroll-s32-s33` (WSL: `/mnt/e/Claude/operro-payroll-s32-s33`)
- Branch: `claude/sections-32-33-payroll-exports`
- Created: 2026-09-27
- GitHub: https://github.com/wbudiman1995-coder/Operro

Other engines (read-only, do not touch):
- Engine 1: `E:\Claude\operro-review-s23-s26`, branch `claude/sections-23-26-memberships` (sections 23-26)
- Engine 2: `E:\Claude\operro-sections-27-30`, branch `claude/sections-27-30-documents-payments-visits` (sections 27-30)

## 3. Status: IN PROGRESS — reconnaissance phase

Worktree created, handoff skeleton committed, environment set up:
- Own Supabase local stack: `project_id = operro-payroll-s3233-local`, ports api=54351 db=54352 studio=54353 inbucket=54354 (edited `supabase/config.toml` in this worktree only). Other engines' stacks verified running and untouched: `operro-m13-local` (54321-54324, = main repo `operro-local-dev`), `operro-s2730-local` (54341-54344, = Engine 2). `supabase start` launched in background (WSL).
- `npm ci` running in background (this worktree has its own `node_modules`, not shared).
- No xlsx/pdf/csv library is currently installed anywhere in the repo (checked package-lock.json + node_modules) — section 33 will need a new dependency. HomePaw's own source uses SheetJS (`XLSX.utils.*` / `XLSX.writeFile`, browser CDN global) for its payroll export — plan to add the `xlsx` (SheetJS) npm package server-side for parity, or `exceljs` if SheetJS's community edition proves awkward for Node buffer output; decide when implementing section 8.
- `run_all_gates.sh` GATE 4 hardcodes an `EXPECTED_MIGRATIONS` bash array that must exactly match `supabase/migrations/*.sql` — new migrations MUST be appended there (additive) or the lineage check fails the whole gate run. Tracked as a required shared-file edit (Section 7).
- `run_all_gates.sh` defaults to `PGPORT=54322` for its disposable `operro_gate`/`operro_cc` databases — that port is currently the **main repo's live `operro-m13-local` Supabase Postgres (17.6.1)**, not a throwaway PG16. Running the gate script unmodified would createdb/dropdb inside another engine's real dev database. Plan: run a disposable `postgres:16` Docker container on a free port (not overlapping 54321-54324/54327/54341-54344/54351-54354) and pass `PGPORT=<that port>` when invoking `run_all_gates.sh`. Document actual Postgres version used per the brief's requirement.

HomePaw payroll source research (via subagents, both `index (2).html` 2026-09-18 and `index (3).html` 2026-09-26 — the newer file is authoritative for current HomePaw behavior, but this Engine 3 brief itself (not just HomePaw) explicitly requires retroactive styling-commission tiers, which only `index (2).html` has — `index (3).html` simplified styling to a flat per-job incentive + per-groomer override. Decision: implement tiers as the brief requires, informed by `index (2).html`'s `stylingTiersEffective`/`stylingPctFor` logic):

- **Lifecycle/export research complete** (see Section 5 below for extracted formulas once calculation-engine research also lands). Key findings:
  - HomePaw has NO `payroll_runs` concept — payroll state is per-groomer-per-cycle rows in a `groomer_payouts` table (no row = pending; `status='paid'` row = paid). Operro's existing `payroll_runs`/`payroll_items` (cycle-level run containing per-groomer items) is a *better* structure than HomePaw's — keep it, extend it, don't flatten it to match HomePaw.
  - **HomePaw's "undo payment" is a hard DELETE of the paid row — no audit trail, no history.** The brief explicitly forbids this pattern ("auditable reversal... do not delete paid rows, erase who/when"). This is intentionally NOT what Engine 3 will port; a real compensating-reversal (mirroring the `reverse_package_reservation` pattern in `20260922140000` — status transition + compensating ledger row, never delete) will be built instead.
  - HomePaw's paid-lock is purely a client-side render decision (paid → show frozen `payout.breakdown` as read-only text instead of live-recomputed inputs); nothing stops calling mark-paid twice with different values (no version/optimistic-concurrency check). Must build proper guards.
  - Publish/hide: `pay_snapshot` jsonb column directly on the groomer's row, shape `{enabled, status:'PAID'|'BERJALAN', label, start, end, published_at, breakdown:{basic,weekly,noLate,noSick,styling,botak,transport,perDog,daily}, custom_rows:[{label,amount}], total}` — exactly matches what `groomer (3).html`'s `renderMyPay()` (lines 304-334) expects. Operro should mirror this breakdown shape (adjusted for retention, which HomePaw pays as a separate `payout_type:'retention'` row/flow).
  - Payroll export: SheetJS 3-sheet workbook (Summary / Detail Job / Missing & Review) — see full column list to be pasted into Section 8 once written. No CSV-injection escaping in HomePaw's source — brief requires adding it; will not port that gap.
  - Custom pay rows pre-payment live ONLY in per-admin browser localStorage (not shared/synced) until marked paid, at which point they freeze into the paid row's breakdown. Operro must do this server-side/shared from the start (no equivalent gap to preserve).
  - No idempotency/concurrency protection anywhere in HomePaw's payroll mutations (confirmed absent) — confirms Engine 3 is building this safety net new, per brief Section 6, not porting anything.
  - Missing/unmatched detection: appointment `status='done'` in cycle with no invoice covering that pet/date = shows in "Missing & Review" sheet and in a detail-drill-down modal.

- **Calculation-engine research in progress** (styling tiers, basic/weekly/bonus formulas, botak, transport split, per-pet size matrix, retention, working-day/attendance integration, job-count definition) — will be appended here when the subagent returns, then the full calculation contract (Section 5) gets written before any money-path code.

Next action once calculation research lands: write Section 5 (calculation contract) in full, then design the new migration(s).

## 4. Parity matrix (HomePaw function/location → Operro implementation → missing delta → UI entry point → test/evidence)

_To be filled in during reconnaissance — do not skip._

| # | HomePaw capability | HomePaw source anchor | Operro current state | Delta | UI entry point | Test/evidence |
|---|---|---|---|---|---|---|
| | | | | | | |

## 5. Calculation contract

Source: HomePaw `index (2).html` (2026-09-18, has retroactive styling TIERS) and `index (3).html`
(2026-09-26, flat styling + household-attendance-visit fix), both fully extracted by research
subagents with file:line citations (raw reports no longer in context; decisions below are final).
Where the two HomePaw versions disagree, or HomePaw has a known bug, or Operro's existing schema
is already structurally better than HomePaw's flat data model, an explicit policy is chosen and
documented instead of silently picking a default.

### 5.1 Period boundaries / timezone

- `payroll_cycle_settings` (new, one row per org): `cycle_start_day int (1-28)`. Business timezone
  = `organizations.timezone` (already exists, e.g. `Asia/Jakarta`), NOT the app server's local time
  and NOT `toISOString().slice(0,10)` (the exact anti-pattern already present in
  `payroll/page.tsx:currentMonthBounds` and `attendance/page.tsx:resolveCycle` — both will be
  replaced). All period math computed in Postgres via `date`/`at time zone`, exposed through an
  RPC (`app.payroll_cycle_for(p_org, p_anchor date, p_direction)`), so the client never derives a
  period boundary itself.
- Cycle N = `[cycle_start_day of month M, cycle_start_day of month M+1)` — inclusive start,
  exclusive end, matching HomePaw's `getPayrollCycle` (both files byte-identical) except computed
  in the org's timezone, not the browser's local clock. `cycle_start_day` clamped to 1-28 so every
  month has that day (avoids HomePaw's unstated Feb-29/30/31 edge case entirely rather than
  guessing a clamp policy).
- `payroll_runs.period_start/period_end` (existing columns) are the frozen, authoritative period
  once a run row exists. A new `exclude using gist` constraint (btree_gist already enabled) on
  `(organization_id, coalesce(branch_id,'00000000-0000-0000-0000-000000000000'), daterange(period_start,period_end,'[)') with &&)`
  makes overlapping/duplicate periods for the same org+branch impossible at the DB level — this is
  the concrete fix for "changing cycle settings must not create duplicate/overlapping periods."
  Changing `cycle_start_day` only changes how FUTURE periods are computed; existing `payroll_runs`
  rows are never recomputed or mutated by a settings change.
- Branch scoping: `payroll_runs.branch_id` (existing, nullable) — decision: **runs are
  organization-wide by default** (`branch_id null`), matching HomePaw (single-location tool with no
  branch concept). An org that enables branch-scoped runs sets `branch_id`; the exclusion
  constraint above prevents the same groomer's cycle being paid twice under different branch
  scoping for the same dates. A multi-branch staff member's pay is attributed to ONE run only —
  enforced by `payroll_items` having exactly one row per `(payroll_run_id, membership_id)` — so a
  membership working two branches must be paid from a single org-wide run, never two branch runs
  for the same period (documented gap: true per-branch payroll split for one shared membership is
  out of scope; flag it in the export as a known limitation if it ever occurs).

### 5.2 Compensation source: effective-dated, canonical service roles

- `staff_compensation` (existing) already supports `effective_from`-versioned base salary; payroll
  reads the version effective on each day of the cycle (not just "latest"), so a mid-cycle rate
  change prorates correctly day-by-day rather than applying the new rate to the whole cycle.
- New `service_catalog.payroll_role text check (payroll_role in ('basic_grooming','styling','botak') or null)`
  — canonical, admin-configured classification replacing HomePaw's `services.name === 'Botak'` /
  `'Basic Grooming'` / `'Styling'` substring matching (brief requirement: canonical IDs, not
  string matches). Seed migration maps the existing `Basic Grooming` service row and adds
  `Styling`/`Botak` service rows with this role set; an org that renames a service keeps its role
  (it's a column, not a name lookup). If more than one service in a category is ambiguous (e.g. two
  differently-priced "Styling" variants), the admin explicitly tags each with the role — no
  auto-guessing.

### 5.3 Per-groomer settings resolution (global default → per-groomer override, explicit inherit-vs-zero)

New `staff_payroll_settings` (one row per membership, all fields nullable = "inherit org default"):
`weekly_salary_enabled bool, weekly_salary_amount, no_late_enabled, no_late_amount, no_sick_enabled,
no_sick_amount, styling_enabled, styling_tiers jsonb, botak_enabled, botak_amount, per_pet_enabled,
per_pet_amount, per_pet_size_matrix jsonb, daily_enabled, daily_amount, retention_enabled,
retention_amount_per_month, retention_term_months`. A field being **NULL** = inherit the org
default; a field being a **real value including 0** = deliberate override (this is the literal
mechanism the brief demands for "explicitly distinguish missing/inherit from a deliberate zero" —
column presence/absence via NULL, not a sentinel).

Org defaults live on `payroll_cycle_settings`: `styling_tiers_default jsonb` (array of
`{min_jobs int >=1, pct numeric >=0}`, default `[{min_jobs:1,pct:10},{min_jobs:17,pct:20}]` —
HomePaw's actual shipped default, kept as the starting point, fully editable), `botak_amount_default`
(10000), `per_pet_amount_default` (20000) + `per_pet_size_matrix_default jsonb` (small/medium/large/
extra_large amounts, all optional — mirrors `service_catalog.price_*` size-matrix pattern already
in the codebase), `weekly_salary_amount_default`, `no_late_amount_default`, `no_sick_amount_default`,
`daily_amount_default`.

**Deliberate deviation from HomePaw's actual (buggy) behavior, done on purpose per the brief's
explicit requirement, not an oversight:** HomePaw's `groomerComp().perDog.useMatrix/amount` fields
are saved and rendered in its UI but the real `computeGroomerDogsInCycle` function never reads
them — every groomer is silently paid the single global flat `rate_per_dog`, regardless of the
size-matrix toggle a business owner thinks they configured. The Engine 3 brief explicitly lists
"Per-pet flat rates or size matrices" as a required, real, wired feature (section 4.2/4.3) — so
Operro's per-pet pay resolver actually reads `per_pet_size_matrix` (falling back to the flat
`per_pet_amount`) instead of reproducing the dead toggle. This will be called out to the owner as a
functional improvement over the literal HomePaw source, not silently ignored as "matching the
source."

### 5.4 Job/line eligibility (replaces HomePaw's invoice-only heuristic with Operro's stronger signal)

HomePaw treats "an after-visit invoice exists for this dog on this date" as completion proof,
explicitly because its flat appointment model has no reliable status field. Operro already has a
stronger, native signal — `grooming_job_pets.status = 'complete'` per pet (the same field
`app.complete_booking` already gates commission accrual on) — so payroll eligibility requires
**both**, which is strictly more correct than porting the invoice-only heuristic:

A `grooming_job_pet_service` line counts toward a groomer's payroll for a cycle when:
1. `grooming_job_pets.status = 'complete'` for that pet (real completion, not merely scheduled).
2. `grooming_job_pet_services.deleted_at is null` and `item_type` is a real service line (never
   `item_type='package'` — HomePaw's "exclude package SALE invoices" requirement is structurally
   automatic in Operro because `sellPackageAction` never creates an `invoices` row at all; a
   package-sale never reaches payroll by construction, not by filtering).
3. The owning booking has **some** invoice (`orders.booking_id` → `invoices.order_id`) with
   `status <> 'void'` — `document_type` may be `'invoice'` OR `'service_report'` (a
   package/subscription-**redeemed** zero-due completed session is still real delivered work and
   counts, per brief section 5's explicit requirement — this is the "eligible package-REDEEMED
   completed grooming" case).
4. The job's date (`bookings.starts_at`, business-timezone date) falls inside `[period_start,
   period_end)`.
5. Assigned groomer = `grooming_job_pets.assigned_resource_id → resources.membership_id`.
6. Dedup key = `(grooming_job_pet_service.id)` itself (a real primary key — no need for HomePaw's
   synthetic `apptId|dogId|groomerId` string key).

A `complete` pet whose booking has **no invoice at all** is the "missing/unmatched" exception queue
(section 5.8 / export sheet 3), never silently dropped and never fabricated an invoice for.
Void/cancelled/no-show/refunded bookings never reach `status='complete'` (Operro's booking state
machine already prevents this — see `app.complete_booking`'s `not in ('confirmed','in_progress')`
guard), so they are excluded by construction, not by an extra payroll-side filter.

Job counting granularity (matches HomePaw exactly, verified identical in both source files): **one
countable "job" = one (booking, pet) pair**, i.e. `grooming_job_pets.id`, not one invoice and not
one service line. A pet with both a `basic_grooming`-role line and a `botak`-role line is one
Basic Grooming job (paid once) that also independently triggers the Botak incentive (stacks, does
not multiply) — this is a per-pet boolean check (`exists a basic_grooming line` / `exists a botak
line` for that pet), not a per-line count, exactly matching HomePaw's `services.includes('Botak')`
boolean semantics.

### 5.5 Component formulas

- **basic** = the effective-dated `staff_compensation.base_amount` snapshot for the cycle (prorated
  by effective-dating within the cycle if the rate changed mid-cycle; HomePaw's `g.basic_salary` was
  a single unversioned field with no proration at all — Operro's existing effective-dated table is
  strictly better here and is used as-is).
- **weekly** (prorated weekly salary): `round(weekly_amount / 6 * min(6, worked_days_in_that_ISO_week))`
  summed over every week touching the cycle — verbatim port of HomePaw's 6-day-week rule (both
  files byte-identical). "Worked days" = business-timezone dates in-cycle, up to *today* only for
  the current/future cycle, whose weekday has a `resource_availability(kind='available')` window
  AND is not blocked (5.6), matching HomePaw's `groomerWeeklyPaidDays` semantics on Operro's actual
  availability schema instead of a raw comma-string `working_days` field.
- **no-late bonus**: `no_late_amount` if zero **unwaived** `attendance_records.classification='late'`
  rows for that resource's bookings in-cycle, else 0. Adopts HomePaw's **FILE3** semantics (the
  2026-09-26 fix), not FILE2's: a `missing_photo` classification does NOT break the no-late bonus
  (only an actual `'late'` does) — matches Operro's own attendance schema, which already keeps
  `late` and `missing_photo` as separate classification values (unlike HomePaw's flat model, which
  needed the FILE3 rewrite to tell them apart). A `waived_at`-set attendance record never counts
  against the bonus, in either HomePaw version or here.
- **no-sick bonus**: `no_sick_amount` if zero resource-level blackout days with `reason='sick'`
  in-cycle (see 5.6) — leave/holiday/other blackout reasons do not break it, matching HomePaw.
- **styling commission — retroactive tiers** (ported from FILE2, per the brief's explicit
  requirement, even though HomePaw's own newer FILE3 dropped tiers for a flat rate): count = number
  of distinct pets in-cycle for this groomer with ≥1 eligible `styling`-role line (5.4); revenue =
  sum of `line_total` for those lines; effective tiers = per-groomer `styling_tiers` override if
  non-empty, else org `styling_tiers_default`; applied percent = the highest tier whose `min_jobs
  <= count` (retroactive — the whole cycle's styling revenue is taxed at ONE percent, not a
  marginal/bracketed rate, exactly matching HomePaw's `stylingPctFor`); `styling_pay =
  round(revenue * applied_pct / 100)`.
- **botak incentive**: count = number of distinct pets in-cycle for this groomer with ≥1 eligible
  `botak`-role line (regardless of whether that pet also has a basic-grooming line — stacks, per
  5.4); `botak_pay = botak_amount (per-groomer override, else org default) * count`.
- **transport half-share — FIXED rounding policy (HomePaw bug, not ported):** HomePaw pays
  `round(fee/2)` **independently to every distinct groomer** on a multi-groomer booking, so N
  groomers on one invoice collectively receive `N * round(fee/2)` — i.e. more than the fee itself
  once N≥3, and even at N=2 the two halves (`round(fee/2)` twice) can exceed `fee` by a rounding
  cent. Operro's explicit, documented policy instead: `half_pool = round(booking.travel_fee / 2)`
  is the total pool ever paid out for that booking, split **equally** among the distinct groomers
  who have ≥1 eligible completed pet on that booking, remainder cents (from integer division)
  assigned deterministically to the lexicographically-first `membership_id` so the sum of shares
  always equals `half_pool` exactly, never more. Paid once per (booking, groomer), never per pet.
  Pool source = `bookings.travel_fee` (existing column, `fulfillment_mode='home'` only, same field
  the existing invoice fee line already reads from `invoice_discounts_charges.sql`).
- **per-pet Basic Grooming pay**: `per_pet_amount` (per-groomer override, else org default) OR, if
  `per_pet_size_matrix` is configured (global or per-groomer) and the pet has a `pets.size`
  classification with a matching matrix entry, that size's amount instead — falls back to the flat
  amount when the pet has no size or the matrix has no entry for that size (same null-fallback
  pattern as `service_catalog.price_small` etc.). Paid once per eligible pet with a `basic_grooming`
  line (5.4), regardless of quantity.
- **daily allowance**: `daily_amount * days_worked`, `days_worked` computed identically to the
  weekly-proration day count (5.6), i.e. scheduled-and-not-blocked business days up to today.
- **custom/additional rows**: free-form `{label, amount}` rows, org/admin-entered per (run,
  membership) — see 5.9 for persistence (server-side from the start; HomePaw's per-browser
  `localStorage` draft is a known source gap, not ported).
- **retention** (see 5.7).
- `takeHome = basic + weekly + noLate + noSick + styling + botak + transport + perDog + daily + sum(custom_rows)`
  — a flat sum of independent, stackable components, exactly like HomePaw's `COMP_LINES` reduce.

### 5.6 Working days, blocked days, join date

- "Scheduled" weekday = a `resource_availability(kind='available', day_of_week=X)` row exists for
  that resource covering the date (`effective_from`/`effective_to` range).
- "Blocked" day = a `resource_availability(kind='blackout')` row for that specific resource
  overlapping the date (new column added: `reason text check (reason in ('sick','leave','holiday','other') or null)`,
  additive to the existing table) **OR** a `branch_availability_blocks` row for that resource's
  branch overlapping the date. Branch-wide blocks are always treated as `reason='holiday'` for
  payroll purposes regardless of their free-text `reason` column — a whole-business closure is
  never a specific groomer's personal sick/leave record, so it can reduce `daysWorked`/weekly
  proration but can never itself break the no-sick bonus (which only reason='sick' does).
- **Join-date guard** (ports HomePaw FILE3's fix over FILE2's confirmed bug): a branch-wide block
  dated before the groomer's `resources.hired_at` (new nullable column, additive; backfilled from
  existing `created_at::date` for pre-existing rows) never counts against that groomer — a company
  holiday from before they were hired cannot reduce their weekly pay or block their allowance.
  FILE2 lacked this guard; FILE3 added it 2026-09-26. Operro ports FILE3's fixed behavior.
- All "worked/scheduled" day counts are capped at *today* (business-timezone) for the current or a
  future cycle — a not-yet-elapsed day is never counted as worked. A fully past cycle counts every
  day in its range (the cap is a no-op once the cycle has fully elapsed).

### 5.7 Retention deposit

One-time lump-sum deposit maturing after a configured tenure, ported faithfully from HomePaw
(verified byte-identical between both source files — not a FILE2/FILE3 delta):
`tenure_months = months between resources.hired_at and today (floor, partial month not counted)`;
`accrued_months = min(retention_term_months, tenure_months)`; `balance =
accrued_months * retention_amount_per_month`; `payable = tenure_months >= retention_term_months`.
Payout is a single lump-sum event per groomer, ever (matches HomePaw's actual implemented behavior,
which never re-accrues after a payout — this is HomePaw's real, intentional signing/retention-bonus
design, not a bug to fix, so it is ported as-is and documented rather than silently "improved" into
a recurring benefit nobody asked for). Recorded as its own ledger row
(`payroll_retention_events(membership_id, kind 'accrual_snapshot'|'payout'|'reversal', amount,
payroll_run_id, occurred_at, ...)`), separate from `payroll_items`, so a correction/undo has an
audit trail HomePaw's plain `groomer_payouts` insert never had.

### 5.8 Missing/unmatched exception queue

A `grooming_job_pets.status='complete'` pet whose booking has no invoice at all in-cycle is listed
(never silently dropped, never auto-invoiced) — same signal used for both the on-screen drill-down
and export sheet 3 ("Missing & Review"), single source of truth for both surfaces.

### 5.9 Custom rows and overrides survive recompute (server-side, not HomePaw's per-browser localStorage draft)

`payroll_item_overrides(payroll_run_id, membership_id, component_key, amount, reason,
created_by)` — row PRESENCE means "deliberate override" (including a deliberate 0), row ABSENCE
means "inherit computed value" (5.3's inherit-vs-zero rule, applied at the run level too).
`payroll_custom_rows(payroll_run_id, membership_id, label, amount, sort_order, deleted_at)` — both
tables are read (not touched) by recompute; recompute only regenerates the computed component
values into a fresh `payroll_items` row per HomePaw's own insert-only design, while overrides and
custom rows persist across as many recomputes as needed until the run is approved/paid, at which
point the resulting merged breakdown is frozen into that `payroll_items.breakdown` snapshot exactly
once (5.10).

### 5.10 Snapshot shape (compatible with HomePaw's groomer-facing breakdown keys)

`payroll_items.breakdown` jsonb: `{basic, weekly, noLate, noSick, styling, botak, transport,
perDog, daily, custom_rows:[{label,amount}], styling_meta:{count,revenue,applied_pct,tiers_used},
botak_meta:{count,rate}, retention_meta:{...}, sources:{...line/booking ids used...},
calculation_version}` — the same 9 top-level component keys HomePaw's `groomer (3).html:renderMyPay`
already expects, plus Operro-specific audit metadata HomePaw never captured (source line IDs,
applied rates, calculation version) per the brief's snapshot/audit requirement.

Next: design and write the migration (schema + RPCs) implementing 5.1-5.10, then the UI, then
exports (Section 8), in that order per the checkpoint plan (Section 6).

## 6. Checkpoints

- [x] Checkpoint 1 (frontend half): `/payroll` page + `payroll-actions.ts` + `payroll-data.ts` +
      client components (`payroll-action-form.tsx`, `payroll-staff-card.tsx`,
      `payroll-settings-form.tsx`) — cycle nav, stat cards, settings panel, missing-invoice queue,
      per-component override editor, custom-pay-row editor, staff on/off toggles. Typechecks and
      lints clean across the whole workspace. Old `PayrollWorkspace`/`loadPayrollWorkspace` (in
      `pilot-data.ts`) and the 3 old payroll actions (in `pilot-actions.ts`) removed and replaced
      by the dedicated new modules — see Section 7 for the exact shared-file edits. Added
      `payroll.approve` to `CAPABILITY_KEYS` in `authorization.ts` (was missing; the DB permission
      already existed but nothing in the frontend checked it).
- [x] Checkpoint 1 (backend half): calculation engine — `supabase/migrations/20261001100000_payroll_engine_s32.sql`
      (schema) + `20261001110000_payroll_engine_s32_rpcs.sql` (cycle bounds, working-day stats,
      eligible-pets/transport-shares, `compute_payroll_item`, `recompute_payroll_run`,
      `approve/pay/undo_payroll_run`, override/custom-row RPCs, retention payout, publish/unpublish,
      `get_my_payroll_snapshot`, RLS). Manually smoke-tested end to end against the local DB
      (`operro-payroll-s3233-local`, ports 54351-54354): recompute → approve → pay → idempotent
      pay-retry (no duplicate ledger entry) → undo (compensating ledger entry, run back to draft,
      original `payroll_items` never touched) all verified; publish → groomer
      `get_my_payroll_snapshot()` read verified; a groomer without `payroll.manage` calling
      `recompute_payroll_run` is denied (RLS). **Still open in this checkpoint: the
      `apps/web/src/app/payroll/page.tsx` UI, pilot-actions.ts wiring, cycle settings/per-groomer
      override UI, and the deterministic fixture-based automated test suite** (brief section 10 —
      independently-computed expected values, not the function checking itself) — the manual psql
      checks above are a smoke test, not the required permanent test suite.
- [ ] Checkpoint 2: Controls & snapshots UI (draft edit forms, approve/pay/undo buttons, security/transaction automated tests)
- [ ] Checkpoint 3: Publication & exports (groomer-facing page, publish/hide UI, XLSX/CSV/PDF)
- [ ] Checkpoint 4: Final acceptance (upgrade test, gates, browser E2E, consolidated evidence)

## 7. Dependencies / shared-file edit log

- `apps/web/src/app/pilot-actions.ts`: removed the 3 old payroll actions
  (`recomputePayrollRunAction`/`approvePayrollRunAction`/`markPayrollRunPaidAction`, ~55 lines)
  and their line in the top function-index comment. Replaced by
  `apps/web/src/app/payroll/payroll-actions.ts` (new file, payroll-only). **Overlap risk with
  Engine 1/2: low** — this is a pure deletion of payroll-specific code neither engine's scope
  touches (sections 23-26 / 27-30), and every other export in the file is untouched.
- `apps/web/src/lib/pilot-data.ts`: removed the old `PayrollWorkspace` interface and
  `loadPayrollWorkspace` function (~20 lines) and the now-dead `embeddedStaffName` helper it was
  the sole caller of, plus the function-index comment line. Replaced by
  `apps/web/src/lib/payroll-data.ts`. **Overlap risk: low**, same reasoning as above.
- `apps/web/src/lib/authorization.ts`: added `"payroll.approve"` to `CAPABILITY_KEYS` (1 line,
  additive — the permission already existed in the DB catalog from migration 0011, nothing in
  the frontend read it). **Overlap risk: very low**, additive to a fixed-shape const array.
- `apps/web/src/app/payroll/page.tsx`: full rewrite (was the section-32-free MVP version).
  **Overlap risk: none** — this route is exclusively payroll's.
- `run_all_gates.sh`: appended both new migration files to `EXPECTED_MIGRATIONS` (additive, gate
  requires an exact match). **Overlap risk: real but expected** — Engine 1/2 will each need to
  do the same for their own migrations; whoever merges last resolves a trivial array-append
  conflict, not a logic conflict.
- `supabase/seed.sql`: fixed a stale/wrong comment (said `owner@homepaw.local`, actual code
  creates `wbudiman1995@gmail.com`) discovered while debugging a real login failure during QA.
  **Overlap risk: none** — comment-only, corrects a pre-existing bug affecting all three engines'
  local QA equally.
- No edits to any other engine's migration files, and no edits to `apps/web/src/app/pilot-actions.ts`
  or `pilot-data.ts` beyond the payroll-specific removals above.

## 8. Known gaps / blockers

- **Local environment is under severe resource contention from concurrent engine stacks.**
  `free -h` inside WSL2 showed `973Mi` free of `7.7Gi` total while FOUR full local Supabase
  stacks were running simultaneously: mine (`operro-payroll-s3233-local`), `operro-m13-local`
  (main repo), `operro-s2730-local` (Engine 2), and a fourth, previously-unseen
  `operro-retention-s35-local` stack (not one of the three engines named in this task's brief —
  presumably another concurrent session's work; not investigated further since it isn't mine to
  touch). `supabase_analytics_operro-s2730-local` was observed pegged at ~296% CPU (thrashing).
  Symptom: the Next.js dev server's `fetch` calls to its own Supabase Kong gateway intermittently
  hang ~7s then fail with `TypeError: fetch failed` / `net::ERR_CONNECTION_RESET` /
  `net::ERR_EMPTY_RESPONSE`, even though a bare `curl` to the same endpoint succeeds seconds
  before or after — consistent with WSL2/Docker Desktop port-proxy connections being dropped
  under memory/CPU pressure, not an application bug. Reproduced across a stopped+restarted
  Supabase stack AND a fully restarted Next.js dev server, ruling out stale-process/stale-pool
  explanations. This matches `run_all_gates.sh`'s own pre-existing comment anticipating "known
  WSL host-TCP issues."
  - **What IS verified working through this instability**, via direct `docker exec psql` against
    the real local Postgres (bypassing the flaky Next<->Kong HTTP hop entirely): the full
    `recompute -> approve -> pay -> idempotent pay retry (no duplicate ledger row) -> undo
    (compensating ledger entry, run back to draft) -> publish -> groomer reads their own
    snapshot -> unauthorized recompute denied by RLS` lifecycle (Section 6 checkpoint note).
  - **What IS verified working through the real browser** before the environment degraded: sign-in
    as the QA owner (`wbudiman1995@gmail.com` / `operro-local-qa`), the full `/payroll` page
    rendering real cycle/stat/settings/missing-queue/staff-card data matching the psql-level
    state exactly, and a live component override save (`Basic Grooming per dog` -> Rp 50.000)
    that correctly triggered a server-side recompute and updated the total in the UI
    (Rp 3.600.000 -> Rp 3.650.000) — direct evidence the App Router server actions -> RPC chain
    works end-to-end, not just the RPCs in isolation.
  - **Not yet re-confirmed through the browser** because of this instability: custom-row add (the
    one in-flight attempt hit the network fault mid-submit and needs a clean retry), and
    approve/pay/undo/publish/unpublish through their actual UI buttons (all proven at the RPC
    layer above, just not re-clicked in a live browser session yet). Revisit once the shared
    environment has less concurrent load, or when other engines' stacks are stopped.
  - Fixed a genuine, pre-existing, unrelated bug found while diagnosing this: `supabase/seed.sql`'s
    QA-login comment said `owner@homepaw.local`, but the actual `insert into auth.users` uses
    `wbudiman1995@gmail.com` — the comment was simply wrong and caused a real failed-login
    red herring during this session. Corrected the comment (small, low-risk, shared-file fix).

## 9. Environment identity

- Node/Next: TBD (read `apps/web/AGENTS.md` and package.json)
- Local Supabase Postgres version used for tests: TBD
- Dev port: TBD (must not collide with 54321-54324, 54341-54344 or other engines' dev ports)

## 10. Status as of this session's usage limit (NOT final — resume here)

- Branch: `claude/sections-32-33-payroll-exports` (not pushed yet — local commits only)
- SHA at pause: `4e62d832d1eca8d19bfac443e52310e214da583b`
- Absolute handoff path: `E:\Claude\operro-payroll-s32-s33\docs\handoffs\ENGINE-3-S32-S33-HANDOFF.md`
- **Section 32 (payroll engine): calculation + lifecycle backend DONE and verified (RPC-level,
  via direct psql — recompute/approve/pay/idempotent-retry/undo/retention/publish all confirmed
  correct). Frontend UI DONE, typechecks/lints clean, partially verified live in-browser (login +
  full page render + one live override save, matching the RPC-level state exactly) before local
  environment instability (Section 8) interrupted further click-through testing.**
- **Section 33 (payroll exports): NOT STARTED.** No XLSX/CSV/PDF code written yet. `exceljs` and
  `pdfkit` are installed (`apps/web/package.json`) and picked as the libraries, decision recorded
  in Section 3, but no export route/RPC/UI exists.
- **NOT DONE**: the permanent automated test suite (SQL functional tests under `supabase/tests/`,
  a deterministic-fixture calculation unit test per brief section 10, concurrency tests, RLS
  negative tests) — this session's psql checks were manual smoke tests only, not committed as
  reusable tests. `run_all_gates.sh` has never actually been run in this session (needs a
  disposable Postgres 16 container per Section 3's plan, not yet set up).
- **NOT DONE**: retention-deposit UI has a button but the "eligible" boundary conditions
  (no-term-yet, maturity boundary, already-paid, undo) are untested beyond the RPC's own
  unique-index guarantee. Groomer-side "Gaji saya" card on `/my-schedule` — NOT built yet
  (`loadMyPayrollSnapshot` exists in `payroll-data.ts` but nothing calls it from a page yet).
- Material blockers: none in the code itself. The only real blocker hit this session was
  environmental (Section 8) — concurrent-stack resource contention on this machine's WSL2 VM,
  not anything wrong with this branch's implementation.
- **Exact resume point**: build the `/my-schedule` "Gaji saya" card (small, `loadMyPayrollSnapshot`
  already exists), then Section 33 exports (XLSX via `exceljs`, CSV with formula-injection
  escaping, PDF payslip via `pdfkit`, all reading the same `payroll_items.breakdown` snapshot the
  UI already reads — no second calculation), then the permanent test suite, then a full
  `run_all_gates.sh` pass, then the remaining browser QA (approve/pay/undo/publish click-through,
  cross-tenant/cross-role negative tests, mobile 375px, retention boundary cases) once the shared
  environment isn't contended, then update this section with real final status before pushing.
