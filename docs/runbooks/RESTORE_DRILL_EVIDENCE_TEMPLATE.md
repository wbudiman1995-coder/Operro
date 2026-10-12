# Restore drill evidence — TEMPLATE (copy, fill, store; do not commit filled copies)

Rules: no credentials, connection strings, tokens, signed URLs or customer data in this file. Tick a box only if you saw the
result yourself. A box left unticked means *not checked*, and the drill cannot be recorded as `passed`.

## 1. Identity of the drill

| Field | Value |
|---|---|
| Drill kind | ☐ A. provider-backup  ☐ B. export-archive-dry-run |
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
| Archive manifest hash prefix (B) | |
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
