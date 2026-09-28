# Engine 3 — Sections 32-33 Payroll & Payroll Exports — Handoff

## Integration note — migration version correction (Codex, 2026-09-28)

This branch is called **Engine 4** in the owner's chat tracking; its Git branch, code paths, and existing evidence retain the original Engine 3 naming. Engine 2 independently created migration `20261001100000_payment_workflow_closeout.sql`. Supabase identifies migrations by their numeric version, so that version collided with this branch's `20261001100000_payroll_engine_s32.sql` when branches were combined. Before integration, Codex renamed this branch's three payroll migrations, without changing executable SQL, to `20261010100000_payroll_engine_s32.sql`, `20261010110000_payroll_engine_s32_rpcs.sql`, and `20261010120000_payroll_export_detail_rpc.sql`. The gate manifest and source/handoff references were updated accordingly. These versions were checked against the current Engine 1 and Engine 2 migration directories. Earlier gate logs are evidence for the same executable SQL under its original filenames, not a combined-branch replay. Combined-branch testing remains required. A disposable local database that applied the old payroll versions must be reset or recreated before testing the renamed migration chain; no production database applied them.

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
- [x] Checkpoint 1 (backend half): calculation engine — `supabase/migrations/20261010100000_payroll_engine_s32.sql`
      (schema) + `20261010110000_payroll_engine_s32_rpcs.sql` (cycle bounds, working-day stats,
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
- [x] Checkpoint 2: Controls & snapshots (draft overrides/custom rows, approve/pay/undo/retention RPCs
      wired into the UI, `docs/handoffs/logs/ENGINE-3-S32-S33/` not yet populated with screenshots).
      Security/transaction proof: `run_all_gates.sh` GATE 6b (23 deterministic assertions, including
      the full recompute/approve/pay/idempotent-retry/undo lifecycle and an RLS negative test) +
      GATE 7 (real password-authenticated non-superuser role under actual RLS). See Section 9.
- [x] Checkpoint 3: Publication & exports — groomer `/my-schedule` "Gaji saya" card (reads
      `app.get_my_payroll_snapshot()` live), publish/unpublish buttons on the admin side, real
      `.xlsx` (ExcelJS)/CSV (with formula-injection escaping)/payslip PDF (PDFKit) via
      `GET /payroll/export`.
- [x] Checkpoint 4: Final acceptance — DONE. Completed once the environment
      stabilized (Section 8's instability was intermittent, not permanent):
      - **Full live browser click-through** as the real owner QA login: Hitung payroll -> Setujui
        -> Tandai sudah dibayar -> Publish ke staf, all via actual button clicks (not RPC calls),
        each transition confirmed on-screen.
      - **Groomer's own view verified live**: logged in as `groomer@homepaw.local`, `/my-schedule`
        showed the "Gaji saya" card with the exact published breakdown (status DIBAYAR, correct
        rupiah amounts matching the admin side and the earlier psql/GATE 6b numbers exactly).
      - **All three export formats verified live** via `fetch()` in the real browser session
        (not just unit-level `buildX` calls): XLSX (200, magic bytes `50 4b 03 04` = a real ZIP/
        OOXML file, correct content-type, 8911 bytes), CSV (200, correct content-type, header row
        + one data row matching the UI exactly), payslip PDF (200, magic bytes `%PDF-1.3`, correct
        `Content-Disposition` filename).
      - **Found and fixed a real bug via this testing** (see the `fix(payroll): self-service
        payslip...` commit): the export route's self-download path reused the admin-only,
        `payroll.read`-gated data loader for a groomer downloading their OWN payslip, so RLS
        silently zeroed the result and every legitimate self-download 404'd. Fixed by routing
        self-downloads through `app.get_my_payroll_snapshot()` (the same RPC the "Gaji saya" card
        already uses) instead. This is exactly the class of bug real browser QA exists to catch —
        it would never have surfaced from RPC-level or gate-level testing alone, since those never
        exercised the export route AS a genuinely permission-restricted groomer. Re-verified fixed
        after the change; also re-ran gates 4-7 fresh (Section 9) to confirm no regression.
      - Full gate suite (1-7) run fresh end-to-end on the FINAL code, all green (Section 9).
      **Also completed since**: retention-deposit boundary tests (not-yet-eligible rejection,
      exact hand-computed payout amount, idempotent-retry via the unique-index no-op path, no
      cross-membership leak -- 7 new GATE 6b assertions) and cross-tenant isolation tests (a
      second org's owner cannot approve/act on org1's payroll run by ID, cannot pay retention for
      an org1 membership id -- 3 more GATE 6b assertions; GATE 6b is now 33/33). **Populated-
      upgrade replay verified**: built a disposable DB with realistic PRE-EXISTING data (org,
      staff_compensation, and three payroll_runs in draft/approved/paid status with payroll_items,
      inserted using the schema as it existed BEFORE this engine's migrations), then applied this
      engine's 3 migrations on top -- all pre-existing rows survived with byte-identical values,
      the new `revision` column defaulted to 0 on old rows, and both original immutability
      triggers (`payroll_items` block-update, `payroll_runs` freeze-after-approval) still fire
      correctly against the pre-existing paid history after the upgrade. Evidence and exact SQL
      in this session's transcript; not saved as a committed script (ad hoc, disposable-DB only).
      **Real export evidence saved**: `docs/handoffs/logs/ENGINE-3-S32-S33/samples/` has an actual
      generated `.xlsx` (verified `Microsoft Excel 2007+` via `file(1)`), `.csv`, and payslip
      `.pdf` (verified `PDF document, version 1.3`).
      **Mobile 375px verified**: `/payroll` (header, cycle nav, export buttons, stat cards, staff
      card with all 9 component rows) and `/my-schedule` both render cleanly at a 375px viewport --
      no horizontal overflow, buttons wrap, values stay right-aligned and readable, bottom mobile
      nav visible and not overlapping content.
      **Two self-review passes completed** (brief section 10):

      **Pass 1 — requirement trace, UI -> action -> RPC -> permission -> database -> export**, per
      brief Section 4 item:
      1. Cycle start day/nav: settings form -> `saveCycleSettingsAction` -> direct
         `payroll_cycle_settings` update (RLS: `payroll.manage`) -> `/payroll?anchor=` reads via
         `app.payroll_cycle_bounds`. Traced, works.
      2. All 9 configurable components + custom rows: staff toggles ->
         `saveStaffSettingsAction`/override forms -> `set_payroll_item_override` /
         `upsert_payroll_custom_row` RPCs (draft-guarded, re-trigger recompute) ->
         `payroll_item_overrides`/`payroll_custom_rows` (RPC-only write policy) -> read back into
         the staff card. Traced, works; live-verified via the browser override test.
      3. Per-pet flat/matrix, styling tiers, botak: `compute_payroll_item` reads
         `staff_payroll_settings`/`payroll_cycle_settings`, canonical `service_catalog.payroll_role`
         -- no per-pet or per-tier UI editor exists yet beyond the flat per-pet rate and the org/
         per-groomer tier JSON set via seed/direct DB (**gap**: no admin UI to edit
         `styling_tiers`/`per_pet_size_matrix` JSON directly -- only flat scalar fields are wired in
         `PayrollCycleSettingsForm`/`StaffPayrollSettingsForm`. Functionally correct end-to-end,
         just not editable from the UI yet. Flagged as a real, honest gap, not hidden.**)
      4. Working-day/sick/late integration: `app.payroll_working_day_stats` reads
         `resource_availability`/`branch_availability_blocks`/`attendance_records` directly (no
         separate UI action needed, it's derived, not entered) -- traced, live-verified (Groomer A's
         seeded late record correctly zeroed the no-late bonus).
      5. Eligibility/drill-down/missing queue: `app.payroll_eligible_pets` /
         `app.payroll_missing_invoice_pets` -> rendered in the missing-queue section with a working
         "Buka booking" link -- traced, works; RLS: same `payroll.read` gate as the rest of the page.
      6. Draft edit / immutable paid / mark-paid / undo: full chain traced above (Section 6/9) and
         browser-verified end to end.
      7. Retention: button -> `payRetentionDepositAction` -> `pay_retention_deposit` RPC ->
         `payroll_retention_events` (RPC-only) -- traced and now test-covered (33 assertions
         include retention); **not yet clicked through the live UI** (button exists, RPC proven at
         SQL level, browser click not attempted this session -- honest gap).
      8. Publish/hide: traced and browser-verified both directions (admin publish -> groomer sees it
         live; the reverse "hide" click was exercised at the RPC layer via GATE 6b-adjacent manual
         psql testing earlier in this session, not re-clicked live in this final pass -- honest gap).
      Section 33 exports: traced and browser-verified for all three formats, including the
      self-payslip RLS bug found and fixed via this exact trace.

      **Pass 2 — money/security/concurrency/upgrade/historical-behavior challenge**: this pass is
      what FOUND AND FIXED three real bugs (all three verified via a full fresh PG16 migrate +
      GATE 6b rerun after each, 33/33 every time, no regression):
      1. **Currency**: `recompute_payroll_run`'s first-time INSERT never set `currency`, so every
         new run silently took `payroll_runs`' original `'USD'` table default from migration 0009
         (predates this engine) regardless of the org's real currency -- verified live (a HomePaw
         Demo/IDR org's run showed `currency='USD'` in the database before the fix). The UI/exports
         never displayed the wrong currency (they hardcode IDR formatting), but the STORED value
         was wrong, and it flows directly into the `financial_ledger` entry written on pay -- a real
         accounting-record bug. Fixed: resolves from `organizations.settings->>'currency'`, falling
         back to the org's most common active `staff_compensation.currency`. Also added the guard
         the brief explicitly asks for -- a membership whose compensation currency doesn't match
         the run's now raises `currency_mismatch` instead of being silently summed in.
      2. **Null-matrix hazard**: a `{"small": null}` per-pet size-matrix entry would NULL-poison the
         running per-pet total for every subsequent pet-size group in the same computation, silently
         zeroing unrelated pets' pay. Not reachable through today's UI (no size-matrix editor is
         wired up yet), but a real latent hazard once one is added; fixed cheaply with a coalesce
         fallback to the flat rate for just that one size group.
      3. **First-recompute race**: two concurrent recomputes for a period with no `payroll_runs` row
         yet could both observe "no row" before either commits; the exclusion constraint already
         prevented a duplicate row, but the loser got a raw, unhandled `exclusion_violation` instead
         of the existing run -- not a money-loss or security issue, but not the graceful idempotent
         response financial mutations should give under a race either. Fixed: catches that specific
         exception and adopts the winner's already-committed run.
      Also confirmed (no fix needed): transport shares always sum to exactly the pool (tested at
      n=2, hand-verified at n=3 by inspection of the row_number-based remainder assignment); paid
      runs stay immutable under direct-table-write attempts even after this engine's migrations
      were applied on top of pre-existing paid history (Section 9's populated-upgrade proof);
      concurrent recompute/approve/pay/undo on the SAME existing run serialize correctly via the
      `for update` lock each RPC takes first (reasoned from the code path, not stress-tested with
      real concurrent sessions -- GATE 8's concurrency harness was not run, Section 9).

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

- Next.js 16.2.12, React 19.2.4, TypeScript per `apps/web/package.json` / `tsconfig.typecheck.json`. Node v24.19.0.
- Own local Supabase stack: `operro-payroll-s3233-local`, ports 54351 (api) / 54352 (db, Postgres 17.6.1 -- the Supabase-managed local stack) / 54353 (studio) / 54354 (inbucket).
- Dev server: `npm run dev --workspace=apps/web` on port 3010 (NOT the project's default 3000 -- that collided with an unrelated pre-existing `.claude/launch.json` at the repo-root-level `E:\Claude\.claude\launch.json`, shared across worktrees and pointing at a totally different, unrelated local project called "marketforge" -- do not edit that shared file; just run the dev server directly with an explicit `PORT=3010`, or via a different port, rather than relying on `preview_start`'s launch.json lookup for this worktree).
- **`run_all_gates.sh` actually run this session** (not merely written) against a **disposable `postgres:16` Docker container** (`operro-gate-pg16`, verified `PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2)`), per the brief's PG16 requirement -- NOT against port 54322 (that's the main repo's own live Supabase Postgres 17 stack; reusing it would have commingled gate churn with another engine's real dev database). Because this WSL2 environment has no `psql`/`createdb`/`dropdb` client installed and no passwordless sudo to install one, gate commands were proxied through small shell shims (`~/gate-shims/{psql,createdb,dropdb}`, not committed to the repo, purely local tooling) that run the same commands via `docker exec` into that disposable container, with the repo bind-mounted at `/workspace` so relative `-f path.sql` arguments resolve identically to a native client. This is exactly the "container invocation of unchanged harnesses... for known WSL host-TCP issues" the script's own header comment anticipates -- `run_all_gates.sh` itself was never edited to make this work, only *how it was invoked* changed.
  - **GATE 1 (typecheck): PASS.** **GATE 2 (build): PASS** (`next build` + all 3 package `tsc -b`, including the new `/payroll` and `/payroll/export` routes compiling). **GATE 3 (in-memory + preset tests): PASS**, 25/25 assertions. **GATE 4 (fresh PG16 migrate, all 44 migrations incl. this engine's 3): PASS**, zero errors, `assembly%` function count = 8 as asserted. **GATE 5 (assembly RPC tests): PASS**, 16/16. **GATE 6 (reservation tests): PASS**, 18/18. **GATE 6b (this engine's own payroll test suite, newly added to the script): PASS**, 23/23. **GATE 7 (real authenticated-role integration under actual RLS, password-authenticated non-superuser client role): PASS**, 11/11. Re-run fresh (clean drop/recreate/migrate) after the self-payslip bugfix below -- same result, no regression.
  - **GATE 8 (completion-vs-assembly/reservation concurrency harness) was NOT run.** It shells out to a bash script (`run_concurrency_assembly.sh`) that itself spawns multiple concurrent `psql` processes against a `DATABASE_URL`; wrapping that whole harness through the docker-exec shim approach was judged not worth the added fragility for a harness that doesn't touch payroll code at all (it predates this engine and tests booking-assembly concurrency, not payroll). Not a payroll-specific gap, but honestly unverified this session.
  - The disposable `operro-gate-pg16` container (and its `~/gate-shims/*` wrapper scripts) are local-only, throwaway, not part of any commit, and safe to `docker rm -f` -- they exist purely so gates could run without installing anything system-wide or touching another engine's environment.

## 10. Superseded interim status (kept for the historical record only — see Section 11 for final status)

Earlier in this session, at a temporary usage-limit pause, this section recorded an interim
snapshot (backend done, frontend/exports/tests not yet started). Everything it described as
outstanding was subsequently completed in the same session — see Section 11 for the real final
state. Left in place rather than deleted so the handoff's own history stays honest about how this
work actually proceeded, including the pause and resume.

## 11. Final delivery

- Branch: `claude/sections-32-33-payroll-exports`
- Branch URL: https://github.com/wbudiman1995-coder/Operro/tree/claude/sections-32-33-payroll-exports
- Final SHA: `19136175558485ef3b23c5c39e6b2c3cf2efb054` (this doc's own commit will move HEAD one
  further after this edit — check `git log -1 --format=%H` on this branch for the literal latest;
  every commit through this one is tested and green, so any of the last several SHAs is a safe
  handoff point)
- Absolute handoff path: `E:\Claude\operro-payroll-s32-s33\docs\handoffs\ENGINE-3-S32-S33-HANDOFF.md`
- Absolute evidence log path: `E:\Claude\operro-payroll-s32-s33\docs\handoffs\logs\ENGINE-3-S32-S33\`
- WSL equivalents: `/mnt/e/Claude/operro-payroll-s32-s33/docs/handoffs/...`

### Section 32 (payroll engine): DONE
Cycle configuration, all 9 compensation components (basic/weekly/no-late/no-sick/styling-tiers/
botak/transport-half-share/per-pet flat+size-matrix/daily), working-day and attendance
integration, job/invoice eligibility with a missing-invoice exception queue, editable draft
overrides and custom rows that survive recompute, immutable paid snapshots, approve/pay/auditable-
undo lifecycle, retention deposits, and groomer publish/hide — all implemented, all backed by RPCs
with server-side authorization and revision guards, all verified both at the RPC/gate level (33
deterministic assertions, independently hand-computed expected values) and live through the real
UI in a browser (recompute → approve → pay → publish, and the groomer's own "Gaji saya" view).

### Section 33 (payroll exports): DONE
Real `.xlsx` workbook (ExcelJS: Summary / Detail Job / Missing & Review sheets, numeric cells as
numbers, dates as dates, frozen header rows), cycle CSV (with formula-injection escaping — a
deliberate improvement over HomePaw's own source, which has none), and a per-groomer payslip PDF
(PDFKit) — all reading the exact same `payroll_items.breakdown` snapshot the UI shows, no second
calculation anywhere in the export path. Server-side permission enforcement (`payroll.read` for
whole-cycle exports; a groomer may additionally download only their own published payslip).
Verified live in the browser for all three formats (correct magic bytes, content types, and a CSV
data row matching the UI/database exactly) — this exact testing is what caught and fixed a real
bug (self-payslip download 404ing for a groomer without `payroll.read`, Section 6/9).

### What's honestly still open (not blocking, not hidden)
- No admin UI yet to edit the `styling_tiers` / `per_pet_size_matrix` JSON directly — only the flat
  scalar org/per-groomer fields are wired into `PayrollCycleSettingsForm`/`StaffPayrollSettingsForm`.
  The tiers/matrix work correctly end to end (proven by the test suite and the seed data), they're
  just only settable via direct DB access or a future small settings-form addition, not a bug.
- The retention "pay deposit" button and the publish→unpublish (hide) direction are proven correct
  at the RPC/gate level (33/33 includes retention boundary + idempotency assertions) but were not
  individually re-clicked in a live browser pass in this session's final sweep (publish was
  clicked live; pay-retention and unpublish were exercised via direct RPC calls earlier in the
  session, and via GATE 6b, not re-clicked as UI buttons in the final pass).
- `run_all_gates.sh` GATE 8 (booking-assembly/reservation concurrency harness — predates this
  engine, doesn't touch payroll code) was not run; documented honestly in Section 9 rather than
  forced through a fragile workaround.
- A genuinely concurrent real-browser two-tab payout race was reasoned through and one specific
  race (first recompute for a not-yet-existing period) was found and fixed; it was not stress-
  tested with actual simultaneous sessions/connections.
- Combined-branch, multi-engine integration testing (this engine's branch merged together with
  Engine 1's and Engine 2's) has not happened and is explicitly out of scope for this task — the
  brief reserves that for after all three engines are reviewed.

### Section 31/34
Not touched, not implied complete. Payroll's UI does not link to capital/cash management or the
WhatsApp center.

### Shared-file edits and overlap risk with Engine 1/2
See Section 7 — small, payroll-scoped removals from `pilot-actions.ts`/`pilot-data.ts`, one
additive line in `authorization.ts`, additive appends to `run_all_gates.sh`'s migration list, and
one comment fix in `supabase/seed.sql`. No edits to any other engine's migration files.

### Owner QC checklist (no committed secrets; QA accounts already exist in the seed data)
1. `cd apps/web && npm run dev` (or `PORT=3010 npm run dev` if 3000 is taken by an unrelated
   project's launch config on this machine — see Section 9) against this worktree's own Supabase
   stack (`supabase start`, ports 54351-54354).
2. Sign in as `wbudiman1995@gmail.com` / `operro-local-qa` (owner) → `/payroll` → Hitung payroll →
   Setujui → Tandai sudah dibayar → Publish ke staf → Export Excel/CSV, inspect the downloaded
   files.
3. Sign in as `groomer@homepaw.local` / `operro-local-qa` (Andi) → `/my-schedule` → confirm the
   "Gaji saya" card shows the published amount → download the payslip PDF.
4. `bash run_all_gates.sh` against a disposable PostgreSQL 16 (see Section 9 for exactly how this
   session did it, since this WSL environment has no native `psql` client).
5. `psql -f supabase/tests/20261001100000_test_payroll_engine.sql` against any Postgres 16+ with
   migrations through `20261010120000` applied — 33/33 assertions, rolls back, safe to re-run.

No merge, no deployment, no PR opened per the brief's instructions — only this isolated branch,
pushed after all of the above validation.

## 12. Closeout after the tool-classifier outage (2026-09-28)

This section supersedes the four open payroll items in Section 11. The isolated payroll branch
contains the final changes; no other engine's worktree or database was changed.

- The org and groomer payroll forms now edit styling tiers and the per-pet size matrix. A live
  owner-browser test saved non-default values, reloaded, verified them, restored the prior values,
  and reloaded again. The groomer form also preserves all stored component-enabled flags. During
  this test, a real bug was found and fixed: the prior form derived enabled flags from the
  *current payout amount*, so a zero-payout enabled component appeared unchecked and could be
  silently disabled by saving an unrelated tier change. The loader and form now use the persisted
  settings flags. The cycle settings save now uses a tenant-scoped upsert so a brand-new org with
  no settings row does not get a false success from an update that touched zero rows; an
  authenticated-role insert/upsert was exercised in a rollback transaction.
- The self-service payslip export's `PayrollStaffCard` adapter was updated for the new settings
  fields. This fixed a real TypeScript error caught before the build.
- Publish and hide were both clicked through in the real local owner browser against an approved
  cycle. The initial publication state was restored. The seeded groomer has no `hired_at` value
  and retention is disabled, so the **retention payout button could not be clicked** without
  manufacturing a payout in the demo org. The real RPC retention boundary, amount and
  idempotency remain verified by GATE 6b; a live UI click is still open.
- A genuine two-connection recompute race initially reproduced PostgreSQL `40P01` deadlock at
  the exclusion constraint. The first successful trial had missed this intermittent failure.
  Forward migration `20261013100000_payroll_recompute_race_lock.sql` now takes a transaction-
  scoped advisory lock for each org/branch before first insertion or later recompute. The
  historical `20261010110000` migration remains unchanged. After applying the forward migration
  to a disposable PG17 clone, 12 consecutive independent two-session recompute+pay trials
  passed: each yielded one run and exactly one payout ledger row. The committed
  `integration/run_concurrency_payroll.sh` provides a repeatable authenticated-session test
  against an unused period in a disposable seeded DB.
- The complete `run_all_gates.sh` wrapper was rerun against a disposable PostgreSQL 16.15
  container: gates 1, 2, 3, 4, 5, 6, 6b, 7 and 8 all passed, with the literal final marker
  `ALL GATES PASSED`. For WSL without a host `psql`, set `GATE8_CONTAINER=operro-gate-pg16`;
  the runner now executes the unchanged concurrency harness inside that mounted container.
  The Windows checkout has CRLF shell scripts, so the command ran an LF-normalized temporary
  copy of `run_all_gates.sh` without changing its repository contents.

Raw evidence is in `docs/handoffs/logs/ENGINE-3-S32-S33/closeout/`: `full-gates-final.log`,
`concurrency-after-fix.log`, `concurrency-script.log`, `org-browser.log`,
`staff-browser.log`, `publish-browser.log`, `empty-org-upsert.log`, and the individual
typecheck/lint/build/batch logs. `concurrency.log` captures the pre-fix `40P01` failure;
`full-gates.log` captures the initial Windows CRLF harness failure before the runner fix.
The disposable PG17 clone's restore skipped one Supabase `vault.secrets` table-data ACL operation;
the fresh PG16 gate replay is the authoritative migration and permission check.

No combined-branch merge, PR or deployment occurred in this closeout. The local demo database
has an approved future payroll cycle created for publish/hide browser QA; it is local-only.
