# Handoff: HomePaw parity sections 23-26 (package/membership lifecycle)

## Branch / commits

- Base branch: `local/design-adoption`
- Base commit (verified before editing): `f820b6b904cffd9d7a24af7e395b8effc327fc06` ("Integrate invoice workflow, size pricing and discounts" — combines sections 20-22)
- Work branch: `claude/sections-23-26-memberships`
- Commits on this branch:
  1. `1bd9837` — "Add HomePaw parity sections 23-26: package/membership lifecycle" (all code/migration/test changes)
  2. This handoff file (committed separately, see final SHA reported at the end of this session)
- **Nothing has been pushed, deployed, or applied to any shared/real Supabase project.** All database verification ran against a disposable, local-only `postgres:16` Docker container (`operro_pg16_gate`, created for this session only). No `supabase db push`, no remote git push.

## Gap map (what existed before this branch)

| Area | Before | Gap this branch closes |
|---|---|---|
| Coverage detection | `app.fn_package_available_sessions`/`app.package_available_sessions` correctly subtracted reservations, but the booking wizard (`apps/web/src/lib/bookings.ts`) and Customer 360 (`apps/web/src/lib/customer-360.ts`) both queried the raw `sessions_remaining` cache directly, bypassing that math. No per-pet eligibility existed anywhere. | Batched coverage RPC + real UI (available/reserved split, over-allocation warning); per-pet eligibility enforced in `reserve_package_session`. |
| Packages and memberships | `packages`/`customer_packages`/`customer_package_ledger`/`package_reservations` existed with a working sell → invoice → ledger flow (`app.create_package_invoice`, section 20-22 work). No recurrence concept on packages (only `membership_plans.billing_interval`, a *different*, unrelated table). `source_invoice_id` was metadata-only (`metadata->>'source_invoice_id'`), not a real column. No renewal path at all. A second, dead, ledger-bypassing sale path (`sellPackageAction`/`PackageSaleForm`) was still in the tree, unreferenced by any page. | Real `recurrence_interval`/`per_pet` columns on `packages`; real `source_invoice_id`/`pet_id`/`activated_at`/`renewed_at`/`renewal_count` on `customer_packages`; manual, ledger-backed `app.renew_customer_package`; dead sale path removed. |
| Membership administration | `/programs` was read-only (catalog + customer balances list). No filters, no renew/archive, no detail view. | `/programs/memberships`: status/urgency filters, ledger-derived detail, guarded renew/archive, links back to Customer 360. |
| Subscription reconciliation | Did not exist. | `app.reconcile_customer_package` (read-only preview) + `app.repair_customer_package_balance` (separately authorized, revision-guarded, idempotent, audited write) + matching UI. |

Full column/RPC inventory was captured via a research pass before writing any code (packages/customer_packages/customer_package_ledger/package_reservations schema, every RPC touching them, `create_package_invoice`'s idempotency mechanism, the booking wizard's and Customer 360's actual queries) — not reproduced verbatim here for brevity, but every claim above was verified against migration source, not assumed.

## Files changed (commit `1bd9837`)

17 files, +1211/-76:

**Migration**
- `supabase/migrations/20260925100000_package_membership_lifecycle.sql` (new)

**App code**
- `apps/web/src/lib/bookings.ts` — booking-wizard package loader now also fetches `pet_id` and a bulk `package_reservations` query, computing `reservedSessions`/`availableSessions` per package client-side.
- `apps/web/src/components/booking-wizard.tsx` — package `<select>` shows `available/remaining` and disables exhausted options; an inline warning fires when the customer's in-progress selections for the SAME booking would exceed what's left (server still re-validates under lock regardless).
- `apps/web/src/lib/customer-360.ts` — `loadCustomerPackages` now also calls `app.list_customer_package_coverage` and exposes `reservedSessions`/`availableSessions`/`petName`.
- `apps/web/src/app/customers/[customerId]/page.tsx` — packages tab shows the available/reserved split and pet name.
- `apps/web/src/app/pilot-actions.ts` — new actions `renewCustomerPackageAction`, `setCustomerPackageStatusAction`, `previewPackageReconciliationAction`, `repairCustomerPackageBalanceAction`; removed the dead `sellPackageAction`.
- `apps/web/src/components/pilot-forms.tsx` — removed the dead `PackageSaleForm` (only caller of `sellPackageAction`; not rendered by any page).
- `apps/web/src/app/programs/page.tsx` — added a link to the new membership administration page.
- `apps/web/src/app/programs/memberships/page.tsx` (new) — the section 25 page.
- `apps/web/src/components/membership-filter-list.tsx` (new) — client-side status/urgency/search filter.
- `apps/web/src/components/membership-manager.tsx` (new) — per-row renew/archive/reconcile/repair UI.
- `apps/web/src/lib/membership-admin.ts` (new) — the admin list loader + urgency derivation.
- `apps/web/package.json` — added the new test file to `test:batch1b`.

**Tests**
- `apps/web/test/package-lifecycle-contract.test.ts` (new) — 16 static contract tests against the migration/action source.
- `integration/package_lifecycle_smoke.sql` (new) — 22-assertion SQL integration test (see below).

**Docs / gates**
- `docs/HOMEPAW_PARITY_PLAN.md` — sections 23-26 rows updated to "Done".
- `run_all_gates.sh` — new migration added to `EXPECTED_MIGRATIONS`; **two environment-bootstrap bugs fixed** (see "Fixes made to run_all_gates.sh" below) — these were blocking replay on *any* vanilla (non-Supabase-flavored) Postgres 16/17 image, not something introduced by this branch, but discovered and fixed while getting real database proof.

**Untouched, as instructed:** `operro_batch1a_v3_recovered.patch`, `operro_batch1b_v4.patch`, `.dev-error.log`, `.dev-output.log` (all untracked, still present, byte-identical — confirmed via `git status`/`git diff --check` before every commit).

## Migration: `20260925100000_package_membership_lifecycle.sql`

Forward-only, additive, no prior migration edited. Every new column is nullable or has a safe default; every existing row and every existing RPC caller keeps working unchanged with the new arguments/columns left at their defaults.

**Schema changes**
- `customer_package_ledger`: `+request_key uuid` (unique per org, partial index `where request_key is not null`); `reason` check widened to add `'renewal'` (was `purchase|consumption|adjustment|expiry|refund`).
- `packages`: `+recurrence_interval text not null default 'none'` (`none|week|month|year`); `+per_pet boolean not null default false`.
- `customer_packages`: `+source_invoice_id uuid` (real FK to `invoices`, backfilled from the old `metadata->>'source_invoice_id'` convention, which is still also written for compatibility); `+pet_id uuid` (FK to `pets`, null = any pet, same convention as the existing `service_id`); `+activated_at timestamptz` (backfilled from `purchased_at`); `+renewed_at timestamptz`; `+renewal_count integer not null default 0`; `+revision integer not null default 1`.
- Indexes: `idx_customer_packages_source_invoice`, `idx_customer_packages_pet` (both partial, `where ... is not null`).

**RPC signatures**

```sql
-- unchanged signature, body extended with a per-pet check
app.reserve_package_session(p_line uuid, p_customer_package uuid, p_expires_at timestamptz default null) returns uuid

-- dropped + recreated (parameter list changed; existing callers unaffected, p_pet defaults null)
app.create_package_invoice(p_branch uuid, p_customer uuid, p_package uuid, p_issued_at timestamptz,
  p_due_at timestamptz, p_admin_notes text, p_request_key uuid, p_pet uuid default null) returns invoices

-- new
app.list_customer_package_coverage(p_customer uuid)
  returns table(customer_package_id uuid, package_id uuid, package_name text, service_id uuid, pet_id uuid,
                sessions_remaining integer, reserved_sessions integer, available_sessions integer,
                expires_at timestamptz, status text)

app.renew_customer_package(p_customer_package uuid, p_request_key uuid) returns customer_packages

app.set_customer_package_status(p_customer_package uuid, p_status text, p_reason text default null) returns customer_packages

app.reconcile_customer_package(p_customer_package uuid) returns jsonb   -- STABLE, no writes

app.repair_customer_package_balance(p_customer_package uuid, p_revision integer, p_request_key uuid) returns customer_packages
```

**Why `repair_customer_package_balance` resyncs the cache directly instead of appending a compensating ledger delta** (the one non-obvious design decision in this branch, worth an independent check — see "What Codex should check next" #1): `sessions_remaining` is defined as `sum(customer_package_ledger.delta)` for that package (that's the entire point of the pre-existing `tg_package_apply_ledger` trigger). If the cache disagrees with that sum, appending ONE MORE delta equal to `(ledger_sum - cached)` does not converge them — the new row shifts `ledger_sum` by exactly the same amount it shifts the cache via the trigger, so the gap the function was called to close is preserved, just relabeled. I found this by writing a test for it (see S9-S11 below) that failed against my first draft, then fixed the function to set `sessions_remaining = ledger_sum` directly and record the repair as a `timeline_events` row (`subject_type='package'`, matching the existing `subject_types` registry — not a new ledger delta) instead.

**Fixes made to `run_all_gates.sh`** (both are environment-bootstrap gaps, not migration-lineage changes): the GATE 4/8 bootstrap SQL now also does `create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions;` (a later, pre-existing migration calls `extensions.digest(...)`, which errors on a vanilla Postgres image with no `pgcrypto`) and stubs `auth.uid()` reading `request.jwt.claims` (matching the exact convention `app.fn_current_user_id()`/`app.fn_active_organization()` already use) since one existing RLS policy (`attendance_read`) calls `auth.uid()` directly and it doesn't exist at all on a non-Supabase Postgres image. Without these two fixes, `run_all_gates.sh` cannot get past GATE 4 on any Postgres image except a real Supabase-flavored one.

## UI routes and click paths

- **`/programs`** (existing) — added a card linking to the new admin page.
- **`/programs/memberships`** (new) — owner/admin click path: `/programs` → "Buka administrasi paket" → filter by urgency chip or search → click a customer's name (goes to Customer 360) or "Kelola" to expand a row → "Perpanjang" / "Arsipkan" / "Aktifkan lagi" / "Rekonsiliasi" (shows cached vs. ledger balance; if mismatched, a distinct "Perbaiki saldo sekarang" button appears, gated on `membership.manage`).
- **`/bookings`** (existing wizard, extended) — groomer/staff click path: new booking → step 1 pick customer/pets → step 2 pick a service → if the customer has an eligible package, "Bayar dengan paket" dropdown now shows `available/remaining` per option and disables exhausted ones; picking the same package for two pets in one booking beyond what's available shows an inline warning before submit (server still re-validates under lock at submit time regardless of what the client shows).
- **`/customers/[customerId]`** (existing, packages tab extended) — shows `available/remaining (N dipesan)` and the linked pet name per package.

## Test commands, exit codes, and raw logs

All raw logs are committed in this repo at `docs/handoffs/logs/S23-S26/` (absolute path on this machine: `E:\Claude\operro-local-dev\docs\handoffs\logs\S23-S26\`), so they survive independently of this session's temp scratchpad.

| Command | Result | Log file |
|---|---|---|
| `npm run typecheck -w apps/web` | exit 0, clean | `npm_typecheck.log` |
| `npm run lint -w apps/web` | exit 0 — 0 errors, 1 warning (pre-existing, in `test/invoice-workflow-contract.test.ts`, **not touched by this branch**) | `npm_lint.log` |
| `npm run test:batch1a -w apps/web` | **107/107 pass** | `npm_test_batch1a.log` |
| `npm run test:batch1b -w apps/web` | **257/257 pass** (see flakiness note below) | `npm_test_batch1b.log` |
| `npm run build -w apps/web` | exit 0 — 31 routes, including new `/programs/memberships` | `npm_build.log` |

**Flakiness note:** one run of `test:batch1b`, executed as the last of five heavy commands chained in a single shell invocation, reported `# pass 256 / # fail 1` against test #211 (one of my own new contract tests). Re-running `test:batch1b` alone immediately after: clean, 0 failures. Running just the new file (`test/package-lifecycle-contract.test.ts`) in isolation 5 times in a row: 16/16 pass every time, zero flakes. I could not reproduce the failure in isolation and attribute the one-off to resource contention in this session's WSL2/Docker sandbox (which needed real troubleshooting all session — see below), not a real defect; flagged for Codex to keep an eye on rather than declared safe outright.

### PostgreSQL 16 — the actual database proof

**Environment note (read before judging any "PG16 not available" claim from an earlier session):** this sandbox has no native `psql` installable via `sudo apt` (no passwordless sudo), and WSL2's mirrored networking mode makes `localhost:<published-port>` unreachable from the host for a Dockerized Postgres (`Connection timed out` on every attempt). I extracted a `postgresql-client-18` binary from a `.deb` without root (`apt-get download` + `dpkg -x`) and, once host→container TCP proved unreliable, switched to running every SQL command via `docker exec` directly against a disposable `postgres:16` container (`operro_pg16_gate`) — this has no host-networking dependency at all. Every result below is genuine PostgreSQL 16.15 execution, not a simulation.

1. **Full 41-migration lineage** (every file in `EXPECTED_MIGRATIONS`, including this branch's new one) replayed with `psql -v ON_ERROR_STOP=1` against a disposable `operro_gate16` database: **zero errors**, `SCHEMA_APPLIED_OK`.
2. **GATE 4's own assertion** (`assembly%` function count in schema `app`): **8** (unchanged — this branch adds no `assembly_*`-prefixed function).
3. **GATE 5** (`supabase/tests/20260721001350_test_assembly.sql`, unmodified): **all PASS notices, exit 0.**
4. **GATE 6** (`supabase/tests/20260721001350_test_reservation.sql`, unmodified): **all PASS notices, exit 0** — this is the existing reservation-lifecycle suite; it passing unmodified is the main proof this branch didn't regress existing package-reservation behavior.
5. **New: `integration/package_lifecycle_smoke.sql`** — 22 assertions, **all PASS**: per-pet eligibility (reject wrong pet / accept right pet), coverage listing, reconcile on a healthy package, an *intentionally induced* cache/ledger mismatch (direct `UPDATE` bypassing the ledger) correctly detected, a stale repair request (wrong revision) correctly rejected with `40001`, a correctly-revisioned repair converging cache to ledger and being idempotent on retry, reconcile confirming health again afterward, renewal reactivating an exhausted/expired package and being idempotent, guarded archive (refused while a reservation is outstanding, succeeds once released), cross-organization denial of both `reconcile` and `repair` at the RPC layer, and — as the `authenticated` Postgres role (not superuser) across two real organizations — RLS itself hiding org A's package from org B and showing it to org A.
6. **New: concurrent final-session allocation race** (not a `.sql` file — a small bash script driving two real, separately-connected `psql` sessions against a 1-session package): session A reserves the only session and holds it for 2s before committing; session B, started 1s later, genuinely **blocks** on the `customer_packages` row lock and — after A commits — correctly computes availability `0` and is rejected with `no_sessions_available`. Final reserved-row count: **exactly 1, never 2.** (This is the literal "two organizations... concurrent final-session allocation" proof requested; it's a session-side script, not a committed file, since it's a one-shot verification rather than a permanent gate — see risk #5 below for the recommendation to promote it.)

Raw logs for all of the above: `docs/handoffs/logs/S23-S26/pg16_migration_gate5_gate6_smoke.log` (items 1-5) and `pg16_concurrency_race.log` (item 6).

**What was NOT run as literally scripted:** `run_all_gates.sh` was not executed as one top-to-bottom invocation (it assumes a native `psql`/`createdb`/`dropdb` on `PATH` and host-reachable TCP, neither of which hold in this sandbox — see the environment note above). GATE 1-6's *logic* was reproduced and verified as described above (with two real bugs fixed along the way); **GATE 7** (real `authenticated`-role integration client against `integration/0100_integration_seed.sql`/`0100_integration_client.sql`) and **GATE 8** (the existing `supabase/tests/concurrency/` bash harness, `complete_booking` vs. `assembly_*`/`reserve_package_session`) were **not** re-run end-to-end in this sandbox. I substituted narrower, purpose-built equivalents that cover this branch's own new surface (the `SET ROLE authenticated` RLS check inside the smoke test; my own concurrency race script above) but did not re-verify GATE 7/8's *existing* scenarios still pass post-migration. This is the top item in "What Codex should check next."

## Unresolved risks / scope decisions

1. **GATE 7 and GATE 8 (as scripted) were not re-run** — see above. Everything they'd exercise that overlaps this branch was covered by substitute tests; what's unverified is whether the *unrelated* existing scenarios in those two gates (e.g. `complete_booking` vs. `assembly_void_line` concurrency) still pass with this migration applied. Nothing in this branch touches those code paths, but "nothing touches it" is not the same as "verified."
2. **Membership administration "edit" is narrow by design**: renew / archive / reactivate / reconcile / repair only — no free-form editing of a purchased package's fields (expiry, pet, service) by hand. Flagged as a deliberate scope decision (the parity plan says "edit/renew/details/archive", and renew+archive+reconcile+repair cover the *stateful* lifecycle actions; a raw field-editor was not requested to also exist, so it wasn't built to avoid a second, competing way to mutate the same data outside the ledger).
3. **Renewal does not create a new invoice.** It is a pure ledger/expiry extension (`reason='renewal'`), matching "usable manual renewal path... do not invent automatic card charging or a scheduler." If the business also wants a billable document per renewal (not just per initial sale), that's a follow-up on top of `create_package_invoice`'s existing pattern, not built here.
4. **`docs/HOMEPAW_PARITY_PLAN.md`'s cited HomePaw HTML references** (`index (2).html`, `booking (1).html`, `groomer (3).html`, `join (2).html`, `expand-gmaps.js`) were confirmed absent from this machine in an earlier session covering sections 20-22; sections 23-26 were likewise implemented from the parity plan's one-line descriptions only, not the original HomePaw markup.
5. **The concurrency proof is a one-off script, not a permanent gate.** Recommend adding a `reserve_package_session` race scenario to `supabase/tests/concurrency/` alongside the existing `complete_booking`-vs-assembly scenarios, and wiring `integration/package_lifecycle_smoke.sql` into `run_all_gates.sh` as its own gate step, in a follow-up change.
6. **`integration/invoice_parity_smoke.sql`** (written in the prior, already-merged combined session, covering sections 20-22) is still not wired into `run_all_gates.sh` — noticed while investigating gate wiring for this branch, left untouched as out of scope for sections 23-26.
7. **One flaky `test:batch1b` run** (see above) — not reproducible in isolation; likely sandbox resource contention, not a code defect, but not conclusively ruled out either.

## What Codex should check next

1. **Independently verify the `repair_customer_package_balance` design** (direct cache resync to the ledger sum + a `timeline_events` audit row, instead of a compensating ledger delta). The reasoning is in the migration's own comment block and above; it's the single most load-bearing, least-obvious decision in this branch and deserves a second pair of eyes on the math, not just the tests passing.
2. **Re-run GATE 7 and GATE 8 exactly as scripted** in `run_all_gates.sh`, on a host where the native `psql` client and TCP loopback to a local Postgres actually work (this sandbox's WSL2 mirrored-networking mode made that impossible here) — confirm the *existing* authenticated-role integration and concurrency scenarios still pass with this migration in the lineage.
3. **Confirm `create_package_invoice`'s DROP + CREATE (not CREATE OR REPLACE)** doesn't cause a PostgREST schema-cache staleness issue on a real Supabase project — check whether a `notify pgrst,'reload schema';` is actually needed here (some migrations in this repo include it, some, including this branch's and the immediately-preceding section-22 migration, do not — the convention is already inconsistent, worth resolving in one direction).
4. **Sanity-check the `pg_temp.act_as`/`SET ROLE authenticated` fixture pattern** used in `integration/package_lifecycle_smoke.sql` against a *real* Supabase Postgres (where `auth.uid()` is the genuine function, not this sandbox's stub) to make sure the RLS-as-authenticated-role assertions (S21/S22) aren't accidentally relying on stub-specific behavior.
5. **Review the booking-wizard over-allocation warning** (`booking-wizard.tsx`) — it's a client-side heads-up only (the server's row lock in `reserve_package_session` is the real guarantee, proven by the concurrency test); confirm the UX threshold (comparing in-progress selections across pets in the same draft booking) matches what staff actually expect to see.
6. **Confirm the dead-code removal (`sellPackageAction`/`PackageSaleForm`) is truly safe** — grepped for every reference before deleting (only each other referenced it, no page rendered the form), but worth a second confirmation given it directly touches money/session-balance code.
