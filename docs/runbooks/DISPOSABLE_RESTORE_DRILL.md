# Disposable restore drill — procedure and evidence format

Status of this document: **procedure only.** No drill described here has been performed by this change. Following it
produces evidence; it is not evidence. Operro's recovery claim stays exactly what `/settings/health` says — *not proven*
until a drill has passed and been recorded, *stale* 90 days after the last pass.

This extends [`RECOVERY_READINESS.md`](RECOVERY_READINESS.md) (read it first) with two things it lacked: a drill that
exercises the **organization export archive** end to end without writing to any database, and a fixed evidence format.
A production restore is **out of scope** and must never be attempted from this runbook.

## Two different things — never conflate them

| | What it is | What it can prove | What it cannot prove |
|---|---|---|---|
| **A. Provider backup drill** | Restore a Supabase backup / PITR snapshot into a *new, empty, disposable* project (steps in `RECOVERY_READINESS.md`) | That the provider's backup holds the data and RLS you expect, and the RPO/RTO you measured that day | That Storage objects were restored (database backups do not contain them); that tomorrow's backup works |
| **B. Archive readiness dry run** | Verify an organization export archive offline against a *description* of a disposable target schema (`apps/web/scripts/verify-org-export.ts`) | That the archive is intact, tenant-clean, free of credential-like keys, schema-compatible and foreign-key-closed, with a safe INSERT-only load order | That anything was restored; that Auth identities, Storage object bodies or provider secrets exist (they are not in an archive); recoverability |

Only **A** may be recorded as a passed *recovery* drill. **B** is recorded as `partial` at best, with the note
`kind=export-archive-dry-run`, because it restores nothing. The health page, the runbook and the record form all follow
this rule.

## Preconditions (stop if any is false)

- [ ] A **disposable** Supabase project (or local stack) that nobody uses, created for this drill, whose database name
      you will write down. Production's project reference is written next to it so you can compare — they must differ.
- [ ] The person running it can read production's backups settings but is **not** given production credentials by this
      procedure. Credentials never go in notes, tickets or this repository.
- [ ] A recent **completed and verified** export (for B): `/settings/storage` shows *metadata terverifikasi*.
- [ ] You have 2–4 hours and have blocked deploys during that time (a deploy mid-drill invalidates the schema comparison).

## B. Archive readiness dry run (no database is written)

1. **Pick the archive.** In `/settings/storage`, note the job's completion time and manifest hash prefix. Run
   *Verifikasi metadata* once more and keep the message.
2. **Download it** from the private `organization-exports` bucket (Supabase dashboard → Storage, or
   `supabase storage cp -r ss:///organization-exports/<org>/exports/<job> ./archive --experimental`) into an empty local
   folder. Keep the folder layout: `<org>/exports/<job>/manifest.json`, `configuration.json`, `tables/...`.
3. **Describe the disposable target.** Against the disposable database only:
   ```bash
   psql "$DISPOSABLE_DATABASE_URL" -v org=<organization uuid from manifest.json> -At -f docs/runbooks/restore-schema-probe.sql > probe.json
   ```
   The probe is one read-only `SELECT`; it reads only a `COUNT` per table for that organization.
4. **Run the check** (no network, no database, writes nothing):
   ```bash
   npx tsx apps/web/scripts/verify-org-export.ts ./archive ./probe.json > readiness.txt
   ```
   Exit code 0 = ready, 1 = not ready (each `FAIL` line is a finding), 2 = bad usage.
5. **Read the notes, not just the exit code.** Every pass lists what is *not* covered: Storage object bodies, Auth
   identities, provider credentials, and any foreign key that points outside the archive (for example `users`). Those must
   be provided by other means in a real restore; the drill must say how.
6. Save `readiness.txt`, `probe.json` (it contains table/column names and counts only) and the manifest hash in the evidence
   folder. **Do not** save the archive itself outside the access-controlled bucket.

## A. Provider backup drill (restores into a disposable project)

Follow `RECOVERY_READINESS.md` steps 1–7, plus these hardening rules:

- **Name the restore point and measure both clocks.** T0 = when you start the restore; T1 = when the disposable database
  accepts connections; RTO = T1 − T0. RPO = restore point − newest `app.audit_log.occurred_at`.
- **Run the probe too** (`restore-schema-probe.sql`, with the organization id) and keep `existingRows`: after a
  database restore they will be non-zero — that is the point — and they let you compare counts with production's
  `/settings/storage` scope report (`app.org_export_scope()` counts) for the same organization on the restore date.
- **RLS spot-check as real roles** (not as the project owner): sign in to the disposable project with two throwaway test
  users in different organizations and confirm each reads only their organization. No real user's credentials are used.
- **Immutable history:** confirm `cash_movements`, `whatsapp_draft_events`, `payroll_items` of a paid run and
  `recovery_drills` reject `UPDATE`/`DELETE` as the table owner (they raise `restrict_violation`).
- **Storage separately:** count objects per bucket in production vs the disposable project; record the gap honestly.
- **Never** run migrations on the restored copy, never point the application at it with production secrets, never keep it
  after the drill. Tear it down and write the time.

## Evidence format

Fill [`RESTORE_DRILL_EVIDENCE_TEMPLATE.md`](RESTORE_DRILL_EVIDENCE_TEMPLATE.md) completely, store it where the owner keeps
operational records, and then record the drill at `/settings/health` (platform owner only):

| Record field | Value to enter |
|---|---|
| Tanggal | The date the drill ran (never in the future) |
| Hasil | `passed` only for A when *every* check in the template is ticked; `partial` for A with a documented gap, and for every B; `failed` otherwise |
| Dipulihkan ke | `disposable_project` (or `staging_project` if that is truly what was used) |
| RPO / RTO | Measured minutes from A; leave empty for B |
| Catatan | `kind=provider-backup` or `kind=export-archive-dry-run`; restore point; the one-line gap statement. **No credentials, URLs with keys, or connection strings** (the form rejects them) |
| Referensi bukti | The id or filename of the filled template |

Records are append-only: correct a mistake by recording a new drill.

## What this procedure deliberately does not do

- It does not restore, import or write to any database from an archive. There is no importer in Operro.
- It does not call Supabase or Vercel APIs, read provider billing or quotas, or schedule anything.
- It does not turn a pass into a guarantee. A pass is one dated fact about one backup or one archive.
