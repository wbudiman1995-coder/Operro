# Restore drill evidence — TEMPLATE (copy, fill, store; do not commit filled copies)

Rules: no credentials, connection strings, tokens, signed URLs or customer data in this file. Tick a box only if you saw the
result yourself. A box left unticked means *not checked*, and the drill cannot be recorded as `passed`.

## 1. Identity of the drill

| Field | Value |
|---|---|
| Drill kind | ☐ A. provider-backup  ☐ B. export-archive-dry-run  ☐ C. guarded-archive-restore |
| Date (Asia/Jakarta) | |
| Performed by (name only) | |
| Reviewed by (second person; required for `passed`) | |
| Production project reference (last 4 chars only) | |
| Disposable target reference (last 4 chars only) | |
| Targets differ (production ≠ disposable)? | ☐ yes — **stop if no** |
| Organization drilled (name + id) | |
| Operro build (commit) and `app.schema_version()` in production | |

## 2. Archive / backup under test

| Field | Value |
|---|---|
| Restore point (A) or archive job id (B) | |
| Archive manifest hash prefix (B, C) | |
| Archive manifest sha256, full 64 hex (B, C: this is what you enter on `/settings/health`) | |
| Restore report `reportSha256`, full 64 hex (C only) | |
| SQL file `sqlSha256` from the report (C only) | |
| Last recorded metadata verification (B): date and result | |
| Scope fingerprint (`/settings/storage` → Cakupan arsip) (B) | |
| Tables in the archive / tables with data NOT in the archive | / |

## 3. Clocks (A only)

| T0 restore started | T1 database accepting connections | RTO (min) | Restore point | Newest `audit_log` row | RPO (min) |
|---|---|---|---|---|---|
| | | | | | |

## 4. Checks

**Both kinds**

- ☐ Disposable target confirmed different from production (project refs compared)
- ☐ No production credential was used or written down
- ☐ Findings from the readiness check / data checks are listed in §5 (including every `note` line)

**B — archive readiness (`verify-org-export.ts`)**

- ☐ Exit code 0 (paste the first line of `readiness.txt`): `…`
- ☐ Target table counts for the organization were zero (`target_not_empty` absent)
- ☐ `external_reference` lines reviewed and each explained (which identities must exist before a real load): `…`
- ☐ Append-only tables noted; load would be INSERT-only with triggers bypassed: `…`

**C — guarded archive restore (`restore-org-export.ts` + the generated SQL)**

- ☐ The target database name has no `prod`/`production`/`live`/`main` in it and is not a database anyone uses; marker script run (`restore-target-marker.sql`)
- ☐ The manifest hash printed by the tool equals the hash `/settings/storage` shows for that archive: `…`
- ☐ The script header and the report were read before running; `externalReferences` and `warnings` listed in §5
- ☐ `restore-output.txt` ends with one `RESTORE_RESULT {... "verified": true}` line (paste it): `…`
- ☐ A second run of the same script was refused with `restore_target_not_empty` and changed nothing
- ☐ RLS spot-check and immutability check of A done on the restored data (UPDATE/DELETE refused on `cash_movements`, `marketing_spend_entries`, `financial_ledger`)
- ☐ Database torn down at: `…`
- Record as **partial** at best: C does not exercise the provider backup, Storage objects, Auth identities or secrets.

**A — provider backup**

- ☐ `app.schema_version()` of the restored database equals production's
- ☐ Row counts for organizations, customers, pets, bookings, invoices, payments, payroll_runs within the expected range
- ☐ Three real invoices and three payments compared with production (ids only here): `…`
- ☐ RLS enabled on tenant tables; two throwaway users in different organizations each read only their own
- ☐ Immutable tables reject UPDATE/DELETE as table owner (cash_movements, whatsapp_draft_events, recovery_drills)
- ☐ Storage objects per bucket compared; gap recorded: `…`
- ☐ Disposable project torn down at: `…`

## 5. Findings and gaps (be specific; "none" must be justified)

| # | Finding | Severity | Owner | Follow-up |
|---|---|---|---|---|
| 1 | | | | |

## 6. Outcome to record in Operro

| Field | Value |
|---|---|
| Hasil | ☐ passed (A, every A box ticked, second reviewer) ☐ partial ☐ failed |
| Dipulihkan ke | disposable_project |
| RPO / RTO (min) | / |
| Catatan (no secrets) | `kind=…; restore point=…; gap=…` |
| Referensi bukti (this file's id) | |
| Recorded at /settings/health on | |

## 7. Attestation

I performed the steps above exactly as written, ticked only what I observed, and recorded no credentials in this document.

Name: ____________   Date: ____________        Second reviewer: ____________   Date: ____________
