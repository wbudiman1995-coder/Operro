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

## C. Guarded restore of an archive into a disposable database (writes only to that database)

Kind `C` actually loads an organization-export archive into a database you created for the purpose, with a generated script that
guards itself. It proves that **this archive can be loaded and reproduces its source rows exactly**; it does not prove that Operro
is recoverable (that needs A, and recovery of Storage objects, Auth identities and secrets, which are not in the archive).

What the script guarantees, because it is written into the SQL itself:

1. it runs only in the database named when it was generated (`current_database()`), and only if `public.operro_restore_target`
   exists and says `disposable` (no migration creates it; you declare it with `restore-target-marker.sql`);
2. the database is at the schema version the probe reported, the organization row exists, and **nothing** exists for that organization
   in any table to be loaded (a second run, or a half-restored database, is refused);
3. each chunk is re-hashed in the database against the manifest, every row must carry the archive's organization id, and rows are
   inserted only (append-only and audit triggers are not re-fired, so financial history is not rewritten or re-audited);
4. afterwards each stored row is compared with the archive row, each table's row count and id-list hash must equal the archive's, and
   every append-only trigger must still be enabled; any failure rolls the whole transaction back.

Steps (stop at the first problem):

1. Create an empty database whose name does not contain `prod`, `production`, `live` or `main`. Apply every Operro migration to it.
   Write down its name. It must not be a database anyone uses.
2. Download and verify the archive exactly as in B steps 1-2.
3. Declare the target and create the organization row (no default configuration is seeded):
   ```bash
   psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 -v org=<id> -v name='<name>' -v slug='<slug>' -f docs/runbooks/restore-target-marker.sql
   ```
4. Probe the target (B step 3), then generate the script. **The database name is mandatory**:
   ```bash
   npx tsx apps/web/scripts/restore-org-export.ts sql ./archive ./probe.json --target-database <name> --out ./restore.sql
   ```
   It refuses (exit 1, nothing written) when the archive fails verification, contains an unknown or unsafe table or a credential-like
   column, the target is not empty or at another organization, or the name looks like production. It never connects to a database and
   never overwrites a file. It writes `restore.sql` and `restore.sql.report.json` (counts, per-table id hashes, the SQL's own hash).
5. Read `restore.sql`'s header and the report's `externalReferences` and `warnings`. Check that the manifest hash printed equals the
   hash `/settings/storage` shows for that archive.
6. Run it against the disposable database only, keeping the output:
   ```bash
   psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 -f ./restore.sql | tee restore-output.txt
   ```
   Success prints one line `RESTORE_RESULT {... "verified": true}`. Any error rolls back and leaves the database empty.
   Setting `session_replication_role` needs a role that may do so (the project owner on a local or disposable database).
7. Record the three artifacts for the evidence template: the manifest hash, the report's `reportSha256`, and `restore-output.txt`.
   Then do the RLS spot-check and immutability check of A on the restored data, and tear the database down.

Record kind C as `partial` at best. `passed` is reserved for A, because C does not exercise the provider backup, Storage, Auth or
secrets. The `/settings/health` form accepts the manifest hash and the report hash and marks whether the manifest hash matches a
completed export of this platform (see the evidence section of `RECOVERY_READINESS.md`); the drill remains a human-attested fact.

## What this procedure deliberately does not do

- It does not restore into any database by itself: the generator writes a script, and a person runs it on a database they declared
  disposable. There is no importer inside the application, no restore button, and no route can reach the generator.
- It does not restore Storage object bodies, Auth identities, memberships, roles or provider credentials, or point-in-time state.
- It does not call Supabase or Vercel APIs, read provider billing or quotas, or schedule anything.
- It does not turn a pass into a guarantee. A pass is one dated fact about one backup or one archive.
