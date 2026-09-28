# PostgreSQL 16 gate evidence (sections 27–30)

`run_all_gates.sh` requires a plain, non-Supabase-managed PostgreSQL 16 server
(the isolated dev stack used for browser verification elsewhere in this
handoff is Supabase-CLI-managed PostgreSQL **17**). The full script also
needs `su -s /bin/bash postgres` (a local OS `postgres` user) and orchestrates
`npm ci`/workspace builds/a two-session concurrency harness in the same run —
more than this host's Docker/WSL instability (documented throughout this
handoff) could sustain in one pass. What follows is what WAS actually run,
directly, against a real `postgres:16` Docker container (`operro-gate-pg16`,
host port 55432), reproducing the script's own GATE 4/5/6 steps exactly
(same bootstrap SQL, same migration list, same test files) rather than the
full script wrapper. Every command and result below was observed directly,
not summarized from a truncated log.

## Setup (matches run_all_gates.sh GATE 4's own bootstrap verbatim)

```bash
docker run -d --name operro-gate-pg16 --restart unless-stopped \
  -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16
docker exec operro-gate-pg16 psql -U postgres -c 'create database operro_gate;'
docker exec operro-gate-pg16 psql -U postgres -d operro_gate -f <the same auth/storage stub SQL run_all_gates.sh GATE 4 inlines>
docker exec operro-gate-pg16 psql -U postgres -d operro_gate -f integration/gate_bootstrap_extensions.sql
```

## Result 1 — fresh replay of all 45 migrations (41 base + 4 sections-27-30)

Applied `supabase/migrations/*.sql` in filename order, one `psql -v
ON_ERROR_STOP=1 -f <file>` per migration, stopping on first failure.

**First attempt found a real bug**, fixed in this pass:
`permission denied for table visit_manual_billing`. Root cause: every prior
migration that adds a new table also explicitly `grant`s it to `authenticated`
(e.g. `20260917100000_customer_addresses.sql:62`), because the earlier
blanket `grant ... on all tables in schema public to authenticated` only
covers tables that already existed at that point in the migration timeline.
The Supabase-managed dev stack used for browser verification auto-applies
platform-level default privileges to new tables, which silently masked this
missing grant in `manual_visits`, `visit_manual_billing`, and
`organization_bank_accounts`. A bare PostgreSQL 16 (this gate, and any
non-Supabase-platform deployment) does not have that safety net. Fixed by
adding the same explicit `grant select, insert, update, delete on
public.<table> to authenticated;` line to
`20260927100000_visit_register.sql` and `20260930100000_invoice_documents.sql`
that every other new-table migration already has.

**After the fix, full replay result:** all 45 files applied with `exit=0`,
zero errors, in order:

```
20260721000100_extensions_and_helpers.sql .. 20260924140000_invoice_discounts_charges.sql  (41 base migrations) : all exit=0
20260927100000_visit_register.sql             : exit=0
20260928100000_payment_control_workflow.sql   : exit=0
20260929100000_grooming_evidence_hardening.sql: exit=0
20260930100000_invoice_documents.sql          : exit=0
```

GATE 4's own assertion also verified directly:

```sql
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='app' and proname like 'assembly%';
-- => 8   (matches run_all_gates.sh's `[ "$assembly_fns" = "8" ]` check)
```

## Result 2 — GATE 5 (`supabase/tests/20260721001350_test_assembly.sql`)

Run unmodified against the same PG16 database. **16/16 assertions PASS**
(C1–C16), exit=0. This pre-existing test is untouched by sections 27-30; run
here to confirm nothing in this branch regressed it on the real target
engine.

## Result 3 — GATE 6 (`supabase/tests/20260721001350_test_reservation.sql`)

Run unmodified against the same PG16 database. **All assertions PASS**
(R1–R9, including the R7/R8 sub-cases), exit=0.

## Result 4 — sections 27-30 backend suite (`supabase/tests/S27-S30/test_backend.sql`)

**Second real, PG16-specific bug found and fixed here**: this test's
`app.undo_manual_billing` call failed `chk_visit_manual_billing_undo`
(`undone_at is null or undone_by is not null`) because `undone_by :=
auth.uid()` evaluated to NULL. Root cause: `auth.uid()` is a Supabase-platform
function, never checked into this repo's migrations — the platform provides
a real implementation; `integration/gate_bootstrap_extensions.sql`'s own stub
(pre-existing, not written for this branch) deliberately hard-codes it to
`select null::uuid`, which every EXISTING gate test tolerates (none of them
feed an actor column into a NOT-NULL/CHECK constraint), but this suite's
constraint is the first to actually require a real value. Fixed entirely
inside the test file (not the shared gate bootstrap, and not the product
migrations): `test_backend.sql` now installs its own `create or replace
function auth.uid()` that reads the same `request.jwt.claims` GUC the test's
`act_as()` helper already sets, valid ONLY for the duration of the test's
transaction — `CREATE OR REPLACE FUNCTION` is transactional DDL, so the
override is undone by the test's own final `rollback;` regardless of which
engine it runs against, and is a no-op improvement on the real Supabase stack
(temporarily shadows the platform's real `auth.uid()` with an equivalent
implementation for the transaction's lifetime).

**After both fixes, full result: 35/35 assertions PASS, exit=0**, on real
PostgreSQL 16 — the same 35 assertions verified earlier against the
Supabase-managed PostgreSQL 17 stack (see `test_backend_run.log` and
`test_backend_on_populated_upgrade.log` in this directory), now also proven
engine-portable.

## Not completed in this pass

- The full `run_all_gates.sh` wrapper itself (npm ci / workspace builds /
  GATE 7 integration-client role / GATE 8 two-session concurrency harness) —
  blocked by this host's `sudo` requiring a password non-interactively (no
  local OS `postgres` user reachable without it) and by sustained Docker/WSL
  instability during this session (documented throughout this handoff:
  containers observed cycling under CPU pressure). The SQL-level gates that
  do not depend on the OS-level `su postgres` wrapper (4, 5, 6, and this
  branch's own suite) were run directly instead, as recorded above.
- A true two-session concurrency test for `app.record_payment` (same
  request_key raced by two real concurrent connections, not sequential SQL).
