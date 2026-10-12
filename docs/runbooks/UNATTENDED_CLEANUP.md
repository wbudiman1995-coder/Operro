# Unattended storage cleanup — operator runbook and the decisions it needs

Status: **no scheduler exists in this repository, and none was added.** What shipped (migration
`20261031150000_cleanup_schedule_consent.sql`) is only the owner's *consent record*: off by default, owner-only, audited,
switch-off immediate. Turning it on deletes nothing and starts nothing. The Data & penyimpanan page and the health page say
so in words. Manual, dry-run-first cleanup (`/settings/storage`) remains the only way files are removed.

## Why it stops here

The cleanup RPCs (`storage_cleanup_preview`, `_begin`, `_record`, `_finish`; migration `20261029160000`) deliberately act only
inside a **business owner's own session**: the organization comes from the session, apply needs `is_business_owner_member`.
An unattended job has no session. There is no service-role client in `apps/web`, no cron route, no `vercel.json`, no
`pg_cron` job (a test scans for each and fails if one appears while the availability flag is still false). Inventing a
privileged path in this pass would have created exactly the broad, unreviewed capability the brief forbids.

## Decisions the platform owner must make before anyone builds a runner

| # | Decision | Options and what each implies |
|---|---|---|
| 1 | **Which scheduler** | Vercel Cron → a protected route handler (needs a shared secret and a route that bypasses user auth); Supabase `pg_cron` + Edge Function (needs the function runtime, network egress to Storage); an external runner. Pick one; do not stack two. |
| 2 | **Service identity** | (a) a dedicated Postgres role with narrow `EXECUTE` on *new* `…_scheduled` RPCs that take an organization id and require `storage_cleanup_schedules.enabled` — never the service-role key; or (b) per-organization machine users. (a) is the smaller surface. Either way the identity must be unable to read tenant business data. |
| 3 | **Secret handling** | Where the runner's credential lives, who rotates it, how a leak is revoked (a revoked credential must stop all runs within minutes). |
| 4 | **Cadence and windows** | Weekly/monthly per the consent row; time of day in each organization's zone; a global concurrency cap (for example one organization at a time). |
| 5 | **Failure policy** | Stop for an organization after N consecutive failed/partial runs (suggest 3), mark `disabled_reason`, surface on the health page; never retry in a tight loop. |
| 6 | **Evidence of intent** | Whether a *fresh dry-run preview must be reviewed by a human* before the first unattended apply for an organization (recommended), and the maximum objects per unattended apply (the existing 200 per call). |
| 7 | **Alerting** | Who is told when a run fails, and where (the health page is pull-only). |
| 8 | **Staging soak** | A hosted staging project with synthetic data, three consecutive scheduled runs observed, before any real organization is switched on. |

## Requirements any runner must satisfy (the existing foundation already provides most)

- **Opt-in:** only organizations whose consent row says `enabled = true`; re-check at the start of *every* run.
- **Bounded:** the existing 200 objects per call and 50 per Storage batch; one organization per run.
- **Dry-run first:** a scheduled run begins with `storage_cleanup_preview`; apply only the previewed, still-eligible set
  (the database re-verifies each item and skips anything that became protected).
- **Lease/lock protected:** one running apply per organization (15-minute lease); a second session is refused (`55P03`).
  The two-session test in `supabase/tests/storage_cleanup/` (GATE 8b) is the regression guard.
- **Retryable and idempotent:** per-object outcomes `deleted | missing | failed`; five failures abandon an object;
  repeating a cycle is a no-op.
- **Auditable:** runs, items and tombstoned attachments are audited; the consent row is audited; the runner's identity must
  appear as the actor.
- **Disable at once:** the owner's *Matikan sekarang* clears consent; the runner must also honour a platform-level kill switch
  (decision 2/3) so that one setting stops everything.
- **No billing claims:** never report bytes saved, database size or prices (the cleanup panel asserts none are shown).

## Operator procedure once a runner is approved and built (checklist, not yet applicable)

1. Deploy to **staging**; create two synthetic organizations, one consenting, one not; seed expired evidence.
2. Trigger the runner manually; confirm only the consenting organization's preview was created and only previewed items
   were removed; confirm Storage objects, `attachments.deleted_at` and audit rows agree.
3. Kill the network mid-run; confirm the lease expires, the next run abandons the lapsed one and retries leftovers.
4. Revoke the runner credential; confirm all runs stop. Re-enable only after rotation.
5. Switch on one real organization with the owner's written agreement; watch three cycles; then widen.
6. Record the staging evidence next to the migration in the release notes.

## What to do today

Nothing is scheduled. Owners run *Buat pratinjau* → review → *Jalankan pembersihan* from `/settings/storage` when they want
space back; the health page flags failed, partial, abandoned or pending cleanup and links straight there.
