# Handoff: Section 35 — Retention and renewal

## Status

**In progress.** This file is being kept current as milestones land, per the
S35 brief's instruction to checkpoint continuously rather than leave only
chat claims. See "Checklist" below for exact state.

Baseline SHA (branch point): `bbdffb9eb3563fe5f4c884c5cf186c05522d41aa`
(sections 23-26 Codex closeout, branch `claude/sections-23-26-memberships`).
Worktree: `E:\Claude\operro-retention-s35`. Branch:
`claude/section-35-retention-renewal`.

## Requirement-to-existing-code map

| Requirement | Reused from | Notes |
|---|---|---|
| Renewal preview/pricing/fingerprint | `app.preview_package_renewal`, `previewPackageRenewalAction` | Already gated on `membership.read` only (verified by reading the RPC body) -- no weakening needed, a read-only role can already price a renewal. |
| Renewal mutation | `app.renew_customer_package`, `renewCustomerPackageAction`, `MembershipManager` | Gated on `invoice.issue` + `membership.manage`. Reused unmodified; deep-linked via a new `focusMembershipId` prop, not forked. |
| Membership row shape / mutable-field remount key | `apps/web/src/lib/membership-admin.ts`, `membership-filter-list.tsx` | Preserved; extended with fields needed for the renewal queue (recurrence_interval, ledger-derived held/consumed). |
| Correction form date semantics | `apps/web/src/lib/membership-correction.ts`, `timezone.ts` | Reused as-is; not modified. |
| Calendar-day math in business timezone | `zonedDaysBetween`, `zonedDayISO` (`timezone.ts`) | Reused directly in TS; SQL side uses the equivalent `(x at time zone 'Asia/Jakarta')::date` subtraction so both layers agree (documented in migration comments). |
| WhatsApp link + encoding | `buildWhatsAppUrl` (`customer-360.tsx`) | Reused unmodified -- already handles 0/62/+62/international/malformed correctly. |
| Org-level settings storage | `organizations.settings` jsonb (no dedicated settings table exists) | New `followup_retention` sub-key added via safe `jsonb ||` merge (never a blind full-object replace), so branding/other future keys are untouched. |
| Settings write permission | `settings.manage` (already seeded; already used for `organizations_write` RLS) | Reused; added to `CAPABILITY_KEYS` in `authorization.ts` (was missing from the TS-side allow-list even though the DB permission existed). |
| Audit trail for settings writes | `app.tg_write_audit` / `app.audit_log` | `organizations` never had this trigger attached (deliberately, per its own comment, since it lacks `organization_id`). The trigger already falls back to `app.fn_active_organization()` when that column is absent, so attaching it is safe reuse, not new machinery. |
| Tenant/branch authorization | `app.assert_tenant_authorized`, `app.has_branch` | Reused inside the two new RPCs; no bypass. |
| Last-groomed source of truth | `grooming_job_pets` (status), `bookings` (timing) per `pilot-data.ts`'s own comment that this join is intentional | Fixed the real bug: the old loader required `bookings.status = 'completed'` (whole booking), which hides a pet that is individually `complete` while a sibling pet on the same booking is not. New logic keys off `grooming_job_pets.status = 'complete'` directly and only excludes canceled/no_show/deleted bookings. Added `grooming_job_pets.completed_at` (did not exist) since `updated_at` is re-stamped by the existing generic trigger on ANY later edit (e.g. editing instructions after completion), so it cannot be trusted as "the moment of completion." |
| One-off vs recurring package | `packages.recurrence_interval` (`'none'` = one-off token; `week`/`month`/`year` = recurring) | Reused as the classification field; no new column. |
| Held / available / consumed | `customer_packages.sessions_remaining` (cache) + `package_reservations` (status) + `customer_package_ledger` (consumption sum) | Same formula already used in `preview_package_renewal` (`available = sessions_remaining - reserved_count`); consumed derived from the ledger, never inferred as `total - available`. |

## Checklist

- [x] Worktree/branch created from verified SHA; isolation confirmed (own
      Supabase ports 54361-54364, own `.env.local` not yet written this
      round, no shared containers touched).
- [x] Requirement-to-code map (above).
- [x] Migration `supabase/migrations/20261002090000_retention_renewal_followups.sql`:
      `grooming_job_pets.completed_at` + stamping trigger + legacy backfill;
      `followup_retention` settings backfill (existing orgs -> 30,
      documented 14-day fallback for new orgs at read time);
      `app.get_followup_retention_settings` / `app.update_followup_retention_settings`
      (guarded write, `updated_at`-based concurrency check, placeholder
      validation, explicit `app.audit_log` insert -- NOT a generic trigger,
      see the migration's SECTION 2 comment for why that first attempt
      broke the seed script and was reverted);
      `app.list_overdue_customers` and `app.list_renewal_queue` (paginated,
      customer-grouped, branch/tenant authorized).
      **Verified**: applies cleanly via `supabase start` against a fresh
      disposable local stack (all migrations + all seeds), confirmed by a
      real `npx supabase start` run this session.
- [x] `/followups` page rewritten (two URL-persisted tabs, settings panel,
      search/branch/view filters as plain `<Link>`/GET-form navigation).
- [x] `/programs/memberships?membershipId=&return=` focused deep link
      (sanitized internal-only return path; reuses `MembershipManager`
      unmodified via new `autoExpand`/`returnTo` props).
- [x] Message draft UI (`overdue-queue.tsx`, `renewal-queue.tsx`): editable
      preview, `buildWhatsAppUrl` reuse, copy-to-clipboard with failure
      state, multi-select combined renewal draft with blocked-preview
      handling (F09-shaped logic).
- [x] `npm run typecheck -w apps/web` -- **clean** (0 errors), verified
      this session after a fresh `npm install` in this worktree (git
      worktrees do not share `node_modules`).
- [x] `npm run -w apps/web lint` -- **clean** (0 errors), after fixing two
      real `react-hooks/set-state-in-effect` violations this repo's custom
      lint config hard-errors on (synchronous `setState` reachable directly
      from a `useEffect` body) -- see the two commits' messages for the
      exact fix in each file (deferred into a transition callback in
      `membership-manager.tsx`; replaced with a pure derived-value +
      manual-override pattern, no effect at all, in `renewal-queue.tsx`).
- [x] `run_all_gates.sh`'s hardcoded `EXPECTED_MIGRATIONS` array updated to
      include the new migration (it does a strict lineage-equality check
      against the actual files in `supabase/migrations/` and would
      otherwise hard-fail immediately on GATE 1 for an unrelated reason).
- [ ] **NOT YET DONE**: `bash run_all_gates.sh` itself has not completed a
      passing run this session (see blocker below).
- [ ] **NOT YET DONE**: SQL behavioral tests for F01-F15 as actual
      authenticated roles (planned as a new
      `integration/retention_renewal_followups_smoke.sql`, following the
      exact `pg_temp.ok`/`pg_temp.act_as`/`smoke_ids` convention already
      used by `integration/package_lifecycle_smoke.sql` -- not yet
      written).
- [ ] **NOT YET DONE**: JS contract tests for the new files (planned:
      extend `apps/web/test/package-lifecycle-contract.test.ts` or a new
      `followup-retention-contract.test.ts`, following the existing
      `revoke all on function ...`-bounded-slice pattern).
- [ ] **NOT YET DONE**: `npm run test:batch1a` / `test:batch1b` re-run
      (nothing in this change should affect them, but they have not
      actually been re-run this session to confirm).
- [ ] **NOT YET DONE**: `integration/migration_upgrade_replay.sh` re-run
      against a populated database with the new migration.
- [ ] **NOT YET DONE**: browser verification of any kind (owner, read-only
      role, groomer/no-access, cross-org, mobile) -- the local Supabase
      stack for THIS worktree was started successfully this session, but
      the dev server was never started and no browser session was opened.
- [ ] **NOT YET DONE**: final F01-F15 evidence table, push, final report.

## Current blocker / exact resume point (session interrupted by usage limit)

**Where this stopped**: setting up the disposable PostgreSQL 16 gate
container (`operro_pg16_gate`, the same docker-exec-based transport the
S23-26 closeout used, documented in
`E:\Claude\operro-review-s23-s26\docs\handoffs\S23-S26-HANDOFF.md`) to run
`run_all_gates.sh` and the new SQL behavioral tests. The container was
created (`docker run -d --name operro_pg16_gate -e POSTGRES_PASSWORD=postgres
-v /mnt/e/Claude/operro-retention-s35:/work postgres:16`), started, then
observed to receive a "fast shutdown request" and stop on its own shortly
after (see `docker logs operro_pg16_gate` -- ends with a clean shutdown
sequence, cause not yet diagnosed: possibly a resource-constrained WSL2/
Docker Desktop restart, not obviously caused by anything this session ran
against it). A `docker start operro_pg16_gate` was issued to bring it back
up and had not yet been confirmed successful when the session was
interrupted.

**Exact next commands to resume, from `E:\Claude\operro-retention-s35`**:

```bash
wsl -d Ubuntu -- bash -lc "docker ps -a --filter name=operro_pg16_gate --format '{{.Names}} {{.Status}}'"
# If not running:
wsl -d Ubuntu -- bash -lc "docker start operro_pg16_gate && sleep 2 && docker exec operro_pg16_gate pg_isready -U postgres"
# If it keeps dying, recreate it (safe -- disposable, no data to lose):
wsl -d Ubuntu -- bash -lc "docker rm -f operro_pg16_gate; docker run -d --name operro_pg16_gate -e POSTGRES_PASSWORD=postgres -v /mnt/e/Claude/operro-retention-s35:/work postgres:16"
```

Then, once the container is confirmed healthy (`pg_isready` returns
"accepting connections"):

1. Run `bash run_all_gates.sh` with `PGHOST`/`PGPORT` etc. routed into the
   container via the same tiny `psql`/`createdb`/`dropdb` PATH-wrapper
   approach the S23-26 closeout used (wrappers that `exec docker exec -i -w
   /work operro_pg16_gate <realcmd> "$@"`, with `RUN_AS_POSTGRES=0` so the
   script's own `run_as_postgres` helper does not additionally try `su
   postgres` on the WSL host, which has no such user). GATE 7/8's
   concurrency harness specifically needs the harness directory `docker
   cp`'d into the container and run via `docker exec ... bash
   run_concurrency_assembly.sh` with `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/<db>`
   (container-internal loopback), per the S23-S26 handoff's own note on
   why a plain host-side wrapper is not enough for that one step.
2. Write `integration/retention_renewal_followups_smoke.sql` (new file,
   not started yet) covering F01-F09, F12-F14 as real fixtures/RPC calls
   against two organizations, a `membership.read`-without-`membership.manage`
   role (already proven possible in this codebase -- see the S23-26
   closeout's `read-only-membership.png` evidence and its role setup in
   `package_lifecycle_smoke.sql`), a branch-restricted user, and a
   no-module/no-permission user. Run it via
   `docker exec -i operro_pg16_gate psql -U postgres -d operro_gate <
   integration/retention_renewal_followups_smoke.sql` against the same
   `operro_gate` database `run_all_gates.sh`'s GATE 4 already builds with
   the full migration lineage (no need for a third throwaway database).
3. F10, F11, F15 are best proven live (real renewal double-click/retry,
   real org switch, real correction-panel revisit) -- do these in the
   browser verification pass (step 6 below), not only in SQL.
4. Extend `integration/migration_upgrade_replay.sh` or confirm it still
   passes unmodified (this migration only ADDS a column + two backfills +
   new functions; it should not need the byte-identical-content-hash
   strengthening the S23-26 closeout added for a DIFFERENT migration, but
   verify by actually running it, not by assuming).
5. JS contract tests: add a bounded slice (own `revoke all on function
   app.list_overdue_customers...` / `app.list_renewal_queue...` /
   `app.update_followup_retention_settings...` anchors) to
   `apps/web/test/package-lifecycle-contract.test.ts` or a new
   `followup-retention-contract.test.ts`, then run
   `npm run test:batch1b -w apps/web` (add the new file to that script's
   file list in `apps/web/package.json` if it is a new file) and confirm
   `test:batch1a` is unaffected.
6. Browser verification: start this worktree's own dev server
   (`.env.local` pointing at `http://127.0.0.1:54361` /
   `sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`, printed by the
   `supabase start` output already captured this session) via the Bash
   tool's `run_in_background: true` (the WSL-backgrounding gotcha from the
   S23-26 session applies here too -- do not use a bare `(cmd &)` inside a
   single `wsl` invocation, it does not survive). Then exercise, as real
   browser sessions: owner (settings threshold change + reload persistence
   at the exact boundary; overdue queue with a multi-pet customer covering
   overdue/recent/never-groomed/future-booked; a real renewal through the
   focused `?membershipId=` deep link with exactly one invoice and a
   refreshed queue; message draft copy/open with a special-character
   customer name and a malformed phone number); the seeded
   `membership.read`-only role and the seeded `groomer@homepaw.local`
   no-access role against both tabs and against the settings save
   directly; switching to a second, then an empty, organization; and a
   narrow mobile viewport.
7. Only after all of the above: fill in the final F01-F15 evidence table
   in this handoff with real PASS/FAIL/evidence-path entries (do not mark
   anything PASS that was not actually run), revert `supabase/config.toml`
   (currently modified in this worktree to ports 54361-54364 / project_id
   `operro-retention-s35-local` -- purely a local verification
   convenience, must be `git checkout -- supabase/config.toml`'d before
   the final commit, exactly like the S23-26 closeout's own note), stop
   this worktree's dev server and `npx supabase stop`, commit, push
   `claude/section-35-retention-renewal` only, and report back.

## Files changed so far (this session)

- `supabase/migrations/20261002090000_retention_renewal_followups.sql` (new)
- `run_all_gates.sh` (added the new migration to `EXPECTED_MIGRATIONS`)
- `supabase/config.toml` (local-only port/project_id override -- MUST be
  reverted before final commit, not yet done)
- `apps/web/src/lib/authorization.ts` (added `settings.manage` to
  `CAPABILITY_KEYS`)
- `apps/web/src/lib/followup-retention.ts` (new)
- `apps/web/src/lib/followup-messages.ts` (new)
- `apps/web/src/app/followups/actions.ts` (new)
- `apps/web/src/app/followups/page.tsx` (rewritten)
- `apps/web/src/app/programs/memberships/page.tsx` (deep-link support added)
- `apps/web/src/components/followup-settings-panel.tsx` (new)
- `apps/web/src/components/overdue-queue.tsx` (new)
- `apps/web/src/components/renewal-queue.tsx` (new)
- `apps/web/src/components/membership-filter-list.tsx` (focus-row support)
- `apps/web/src/components/membership-manager.tsx` (`autoExpand`/`returnTo`
  props only -- the renewal/correction logic itself is untouched)

Two checkpoint commits exist on this branch so far:
1. `S35: checkpoint handoff with architecture plan`
2. `S35: implement retention/renewal queues, settings, and deep link
   (typecheck+lint clean)`

`git status` as of this checkpoint still shows `run_all_gates.sh` and
`supabase/config.toml` as uncommitted modifications (config.toml must be
reverted, not committed; run_all_gates.sh's migration-list fix should be
committed once the gates actually pass).
