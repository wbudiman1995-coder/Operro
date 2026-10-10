# Recovery readiness runbook

Status of this document: **procedure only.** Following it produces evidence; it is not evidence. Operro's recovery
claim is exactly what the `/settings/health` page says: *not proven* until a restore drill has passed and been recorded,
and *stale* 90 days after the last pass.

## What Operro can and cannot tell you

| Question | Where the answer comes from | Operro shows it? |
|---|---|---|
| Is the database schema the version this build expects? | `app.schema_version()` vs `EXPECTED_SCHEMA_VERSION` | Yes |
| Did a bounded maintenance job fail or stall (organization export, storage cleanup)? | `organization_export_jobs`, `storage_cleanup_runs` | Yes, as counts/timestamps (no raw error text) |
| Is a capacity request waiting? | `storage_upgrade_requests` | Yes |
| Are there unresolved visit / invoice / payroll discrepancies? | `/reconciliation` RPCs (read-only) | Yes, as counts (capped at 100) |
| Was a restore ever actually performed and verified? | `public.recovery_drills` (human-entered, append-only) | Yes |
| Are Supabase / Vercel healthy? Do backups exist and run? What will they cost? | Provider dashboards | **No.** No provider API is called or simulated. |
| Can the organization export be restored? | A restore drill | **No.** The export verifier proves file integrity and tenancy, not restorability. |

Never put credentials, connection strings, tokens or raw provider logs into the drill notes. The record form rejects
text that looks like one, but the rule is yours to keep.

## Manual recovery exercise (run at least every 90 days, and before relying on a backup)

Use a **disposable** project. Never restore over production.

1. **Plan.** Pick the restore point (a timestamp). Write down the time you start (T0).
2. **Restore** the production backup or point-in-time snapshot into a new, empty Supabase project following Supabase's
   documented procedure (<https://supabase.com/docs/guides/platform/backups>). Record when the restored database accepts
   connections (T1). `RTO = T1 - T0`.
3. **Apply nothing else.** Do not run migrations to "fix" the restored copy; the point is to learn what the backup holds.
4. **Verify data** in the restored project (read-only queries):
   - `select app.schema_version();` equals the version shown on the production health page.
   - Row counts for `organizations`, `customers`, `pets`, `bookings`, `invoices`, `payments`, `payroll_runs` are within
     the expected range for the restore point.
   - Newest `app.audit_log.occurred_at` is within the expected data-loss window. `RPO = restore point - newest row`.
   - Pick three real invoices and three payments and confirm totals and statuses match the production record.
   - Confirm Row Level Security is enabled on tenant tables (`select relname from pg_class where relrowsecurity` includes
     `customers`, `invoices`, `payments`, `payroll_items`).
5. **Verify Storage separately.** Database backups do not contain Storage objects. Confirm what the Storage backup (if
   any) restored: open a sample of attachment rows and check the objects exist. Record the gap if they do not.
6. **Tear down** the disposable project.
7. **Record the drill** at `/settings/health` (Operro platform owner only): date, outcome (`passed` only if steps 4 and 5
   matched; `partial` if some did not; `failed` otherwise), where it was restored (`disposable_project`), measured
   RPO/RTO in minutes, short notes, and an evidence reference (ticket or document id). Records cannot be edited or
   deleted; record a new drill instead.

## Application rollback (separate from data recovery)

Vercel keeps previous deployments. To roll back the web app use the provider's rollback
(<https://vercel.com/docs/deployments/rollback>). Rolling the app back does **not** roll the database back; migrations are
forward-only. If a release added a migration, roll forward with a corrective migration instead.

## When the health page shows attention items

| Item | First action |
|---|---|
| Export failed / stalled | Open `/settings/storage`, resume or cancel the export, then retry. A stalled running export older than 2 hours is almost always an interrupted browser session. |
| Cleanup run partial / abandoned / pending objects | Open `/settings/storage` → cleanup history. Objects marked `failed` are retried on the next run; `abandoned` (5 failed attempts) need a manual look at Storage permissions. |
| Capacity request pending > 14 days | Operro platform owner follows up; no billing is automated. |
| Schema version mismatch | A migration was applied or rolled back without the matching app build. Align the two before continuing. |
| Reconciliation counts > 0 | Open `/reconciliation`. Differences are facts to review, not errors to auto-fix. |

## Limits worth remembering

- A passed drill proves that *one* backup restored *on that date*. It says nothing about tomorrow's backup.
- The health page reads Operro's own tables. If the database itself is down the page cannot load; that absence is itself the
  signal, and provider status pages are the next stop.
- No billing, usage-cost or capacity-cost estimate is produced anywhere in this feature.
