# Claude handoff: parity control-plane batch (dynamic-size payroll, dashboard cards, organization export)

Date: 9 October 2026 (Asia/Jakarta). Local work only: nothing committed, pushed, deployed, or applied to a remote Supabase/Vercel project; no credentials were read; no real accounts or invoices were created.

## 1. Base and what was preserved

- Branch `codex/parity-orchestration`. Work started on `04aecd3` (`Add agent handoff and bundle artifacts`).
- **HEAD moved during the session.** At 12:47 +0700 `a2c5fe6 Complete dynamic size band integration` was committed by the repository owner (not by this session). It contains the previously dirty dynamic-size payroll files (payroll actions/forms/data/export, `payroll-size-matrix.ts`, `size-bands.ts`, `catalog/actions.ts`, the SB-06 smoke, the extended payroll engine test, the upgrade fixture/checks, and the original `20261027100000_size_band_payroll.sql`). My edits sit on top of it. Everything below that says "modified" is relative to `a2c5fe6`.
- Baseline captured before any edit: [baseline-git-status.txt](logs/CONTROL-PLANE/baseline-git-status.txt), [baseline-git-diff-stat.txt](logs/CONTROL-PLANE/baseline-git-diff-stat.txt) (21 modified, 24 untracked at that point). Nothing was reset, cleaned, stashed, or discarded.
- Untracked files I did not touch: `agent-bundles/Operro-DeepSeek-Engine-*.zip`, `deepseek-outsourcing/2026-10-09/`, `scripts/build-deepseek-chat-packets.ps1`, `docs/agent-work/CLAUDE-*.md`, `docs/handoffs/logs/INTEGRATION/sb06-populated-upgrade.log`.

### Inventory before editing

| | Items |
|---|---|
| (a) present, preserved | Dynamic-size payroll (migration, matrix validation, UI, export columns, SB-06 smoke, populated-upgrade checks); dashboard read-model card plan, loader, shell and settings form; export migration/RPC/TS skeleton; payroll engine SQL test additions. |
| (b) defects blocking safe integration | 1) `20261028110000` SQL test wrote `organizations.settings` directly as `authenticated` (`permission denied for table organizations`), so GATE 4b could not pass. 2) Dashboard RPC accepted a *partial* card map. 3) Export: `anon` execute not revoked; `organizations` row exported whole with a one-key settings denylist; allowlist missing `payments`, `invoice_lines`, `order_items`, `payroll_items` and other tables the exported ones reference; chunk and manifest uploads were non-upsert, so an interrupted finalize or a retried chunk could never succeed (manifest `generatedAt` differs on retry); verification downloaded every chunk in one unbounded `Promise.all`; manifest key sort used `localeCompare` (hash depended on server locale); verifier did not check paths, ordering, id ranges, forbidden keys or storage tenant; no resume/cancel/list/verify path; cursor not enforced server-side; `org_export_complete` did not cross-check the manifest; storage listing unbounded; **no SQL test existed for any export function**. 4) `compute_payroll_item` and `payroll_export_detail_rows` (security definer) used `search_path = app, public`. 5) `authorization.test.ts` was already stale at HEAD (3 failing tests, Customer 360 `history` now requires `customer.read`). |
| (c) new work | Everything listed in section 2 under "changed". |

## 2. Files changed and why existing subsystems were reused

Reused, not duplicated: `app.pet_pricing_key` (sizing), `recompute_payroll_run`/`compute_payroll_item` (payroll), `organizations.settings` + `settings.manage` (dashboard cards), `requireActiveWorkspace`/`loadBranchAccess`/capability map, `app.is_business_owner_member` and the existing Storage-policy pattern (`foldername(name)[1] = fn_active_organization()`), existing `run_all_gates.sh` gates, `integration/run_populated_upgrade_rehearsal.sh`, existing test styles (`renderToStaticMarkup` with stubbed server actions, `pg_temp.act_as`-style SQL fixtures). No new analytics, payroll, authorization, or storage system.

### Migrations (all new, none previously applied anywhere; edited in place because they were never applied)

1. `20261027100000_size_band_payroll.sql` (existing; 7 lines changed): `compute_payroll_item` and `payroll_export_detail_rows` now `set search_path = ''` (all references were already schema-qualified; payroll engine + SB-06 gates pass unchanged).
2. `20261028100000_org_export_foundation.sql` (rewritten, see section 4).
3. `20261028110000_dashboard_card_settings.sql`: RPC now requires **exactly** the four known cards, each a boolean (unknown key, missing key, `null`, non-boolean, array, scalar all `22023`); still `settings.manage` + membership, `for update` on the organization row, sibling settings preserved, empty `search_path`, revoked from `public, anon, authenticated` then granted to `authenticated`.

Order: unchanged lineage, then `20261027100000` → `20261028100000` → `20261028110000`; all three are already in `run_all_gates.sh` `EXPECTED_MIGRATIONS` (lineage check passes). **Forward-only**: no down migrations. To undo before release, drop the unreleased migrations and re-create the disposable database; after release, only a new forward migration (e.g. drop the export functions/tables, revoke the bucket policies) is acceptable. The export migration never edits or deletes tenant data; the only side effects are new bookkeeping tables, a private bucket, and 3 Storage policies.

### Web (apps/web)

- Export: `src/lib/org-export-manifest.ts`, `org-export-verify.ts`, `org-export.ts`, `app/settings/storage/export-actions.ts`, `components/organization-export-panel.tsx`, `app/settings/storage/page.tsx` (job list; non-owner gets an explanation, any other list error is logged and the page still renders).
- Dashboard cards: files already present (`dashboard/actions.ts`, `dashboard-settings-form.tsx`, read model, loader, shell). Only tests were added/extended.
- Tests: `test/org-export-contract.test.ts` (13), `test/control-plane-ui.test.tsx` (4, new), `test/dashboard-read-model.test.ts` (+3, incl. a behavioral recording-client test proving hidden cards execute no query), `test/authorization.test.ts` (stale Customer 360 `history` expectations corrected; this is a tracked, previously-clean file outside the batch).

### Database tests / gates

- `supabase/tests/20261028100000_test_org_export.sql` (new) and `supabase/tests/20261028110000_test_dashboard_card_settings.sql` (fixture fixed, negative cases and grant assertions added).
- `run_all_gates.sh`: export SQL test in GATE 4b; GATE 3 TS list gains `dashboard-read-model`, `org-export-contract`, `catalog-actions-validation`, `control-plane-ui`.
- `integration/run_populated_upgrade_rehearsal.sh`: populated-upgrade export probe (below).

## 3. Dynamic-size payroll (verified, one hardening change)

No functional change was needed to the already-present design; verified by GATE 6b, 7m, and the populated upgrade: draft/unpaid recompute resolves live active dog bands via `app.pet_pricing_key`; approved/paid runs refuse recompute (`run_not_editable:paid`) and are byte-identical after rename/re-band; old keys keep history through `perDogDetail` and booking-line snapshots; the matrix trigger validates against `new.organization_id` (add/change only for an active dog band of the row's own organization; unchanged stored entries grandfathered; staff `(organization_id, membership_id)` composite FK keeps the staff row inside its tenant); cats, custom species, unmeasured dogs keep the flat rate; `delete_size_band` still refuses active payroll/line/entitlement dependency. Hardening applied here: empty `search_path` on the two touched definers.

## 4. Organization export: what it is and is not

An **export/archive**, not a backup or restore product. UI copy says so ("bukan cadangan ... belum ada uji pemulihan"). There is no restore code. A dry-run verifier (`verifyStoredOrganizationExport`, button "Verifikasi metadata") re-reads and re-hashes a completed archive; it proves file integrity and tenancy, **not restorability**. Disaster recovery must not be claimed until a restore drill into a disposable project exists.

- Authority: `app.org_export_authorized()` = active organization's own business owner (`is_business_owner_member`, which also excludes the Operro platform owner). Organization comes from `app.fn_active_organization()` in every RPC; the browser sends only a job id (UUID-shaped, re-checked against the organization). Forged `active_org_id` is refused (tested).
- Allowlist (`app.organization_export_table_specs`, 42 tables, each with uuid `id` + `organization_id`, the export SQL test fails if any allowlisted table has a column matching `token|secret|password|api_key|credential|signed_url|service_role|authorization`). Added to the original 25: `booking_recurrence, membership_plans, customer_memberships, order_items, invoice_lines, payments, refunds, tasks, attendance_records, payroll_cycle_settings, staff_payroll_settings, payroll_items, payroll_custom_rows, payroll_item_overrides, payroll_publications, payroll_retention_events, notification_templates`. Not exported (recorded in every manifest's `excluded`): Auth, memberships/roles/permissions, onboarding links and platform invitations (token hashes), platform billing/entitlements, `grooming_jobs` (no `id` cursor), `organization_bank_accounts`, inventory/wallet/loyalty and any unreviewed table, Storage object bodies, signed URLs.
- Configuration file: explicit `organizations` columns, settings keys limited to `documents, followup_retention, dashboard, currency, evidence_retention_days` (so `platform_billing` and any unreviewed key stay out), plus size-band settings, dog boundaries, pet types, service band prices.
- Storage: metadata only (bucket, name, size, mime, updated_at) for `attachments`, `styling-references`, `onboarding-styling` under the organization's own prefix; capped at 20,000 objects with a `truncated` flag carried to the manifest.
- Chunking: <= 200 rows, uuid-v7 `id` cursor enforced server-side (stale/skipped cursor is `invalid_export_work`), deterministic path `<org>/exports/<job>/tables/<table>/chunk-00000.jsonl`, SHA-256 per chunk and per table, versioned manifest (`operro-organization-export` v1) with a self-hash; `org_export_record_chunk` is idempotent (identical replay is a no-op, different replay `chunk_conflict`); `org_export_complete` rejects a manifest that names another organization or whose per-table row counts disagree with recorded chunks.
- Interrupted runs: one `running` job per organization (partial unique index); `org_export_start` resumes it instead of duplicating; uploads are `upsert` (a chunk exists only once recorded); the owner can cancel; verification failure leaves the job running and retryable.
- Storage policies: private bucket `organization-exports`, select/insert/update only for the business owner of the active organization on `<org>/exports/...`.

## 5. Raw results

All logs are under `docs/handoffs/logs/CONTROL-PLANE/`.

Environment: Windows 11, Node v24.19.0, PostgreSQL **16.15** (`postgres:16` in WSL Ubuntu docker, fresh container `operro-cp-pg16`, `template1` given Supabase-style default table grants).

| Check | Command | Result |
|---|---|---|
| Web tests (entire suite) | `npx tsx --test test/*.test.ts test/*.test.tsx` in `apps/web` | `ℹ tests 553 / pass 553 / fail 0 / cancelled 0 / skipped 0` ([log](logs/CONTROL-PLANE/web-all-tests.log)) |
| Focused | dashboard, payroll-dynamic-size, org-export-contract, catalog-actions-validation, control-plane-ui | all pass (inside the 553) |
| Web typecheck | `npm run typecheck` | `exit 0` |
| Root typecheck | `npx tsc -p tsconfig.typecheck.json --noEmit` | `exit 0` |
| Lint | `npm run lint -- --max-warnings=0` | `exit 0` |
| Build | `npm run build` | `✓ Compiled successfully in 3.0s`, `exit 0` (TypeScript phase included) |
| `git diff --check` | | `exit 0` (only CRLF-conversion notices) |
| DB gates (GATE 4 through 8, root GATE 1-3 run separately above) | `run_all_gates.sh` copy inside the container | `ALL GATES PASSED`, `EXIT 0` ([log](logs/CONTROL-PLANE/db-gates-final.log)) **with GATE 7d skipped** (see defects) |
| Dashboard SQL | GATE 4b | `PASS dashboard card settings: complete allowlist, tenant/capability denial, sibling preservation, grants` |
| Export SQL | GATE 4b | six PASS notices: access refusal (manager, outsider, forged org, anon); bookkeeping tables closed; full run (allowlist, paging, tenant isolation, chunk validation/idempotency, manifest agreement, configuration, storage metadata); cross-tenant owner B; structure (no credential-like columns, 14 definers, empty search_path, no anon/PUBLIC); Storage policies |
| Payroll | GATE 6b, 7m | `SB-06 payroll smoke: ALL PASS`; payroll engine H/F/G scenarios pass |
| Populated upgrade | `integration/run_populated_upgrade_rehearsal.sh` (copy in WSL) | `POPULATED UPGRADE PASS`; includes `PAYROLL EXPORT PRESERVATION PASS`, `SIZE BAND BACKFILL IDEMPOTENCY PASS`, and the new `ORGANIZATION EXPORT POPULATED PASS (7 rows across 42 allowlisted tables, every count equals the organization's own)` ([log](logs/CONTROL-PLANE/populated-upgrade.log)) |
| Test sensitivity (mutation) | rerun export SQL test after (1) adding `memberships` to the allowlist and (2) making `org_export_authorized()` return `true` | (1) `FAIL memberships not allowlisted ... got ok`; (2) `FAIL manager start: expected 42501:not_authorized, got ok` |
| Grant review | [grant-review.txt](logs/CONTROL-PLANE/grant-review.txt) | every function of the three migrations: `anon=f`, `PUBLIC=f`; client-callable ones `authenticated=t`; internals (`org_export_authorized`, `compute_payroll_item`, `payroll_pet_size_key`, `tg_validate_payroll_size_matrix`, `payroll_eligible_pets`, `payroll_transport_shares`) `authenticated=f`; the four export bookkeeping tables have RLS on and no `anon`/`authenticated` privilege |

Migration review: all 19 `security definer` functions in the three migrations use `set search_path = ''` (4 + 14 + 1), and two functions this batch only *revokes* (it does not create them), `payroll_eligible_pets` and `payroll_transport_shares`, still carry the older `search_path = app, public`; they are internal (no client execute) and their bodies were outside this batch.

### Environment caveats (exactly as encountered)

- GATE 7d (`integration/retention_renewal_followups_smoke.sql:582`) fails on this PG16 with `ERROR: permission denied for table organizations`. It is the already-known baseline failure on this lineage on a vanilla PG16 and was reproduced before my migration changes ([log](logs/CONTROL-PLANE/db-gates-with-gate-7d-failure.log)); I did not investigate its root cause. The final gate run removes that one line in the container copy only; `run_all_gates.sh` in the repository still runs it.
- The gate harness stubs `storage.objects` without `updated_at` or RLS; the export SQL test adds `updated_at` and enables RLS inside its own rolled-back transaction. Real Supabase Storage was not exercised.
- Gates 1-3 (`npm ci`, workspace build) were not re-run through `run_all_gates.sh`; the root typecheck and the GATE 3 test lists were run directly (above).

## 6. Browser-tested versus not

- **Not browser-tested at all.** No Supabase/Vercel environment was used (the brief excludes credentials), and I did not start a dev server.
- Covered instead: `renderToStaticMarkup` contract tests of `OrganizationExportPanel` (owner vs non-owner, resume/cancel/verify controls, "not a backup" copy) and `DashboardSettingsForm` (four cards, hidden-input state, no org id field); a behavioral recording-client test for dashboard query suppression; production build compiled the pages. These do not replace manual QC of: dashboard as owner / branch-restricted role / role without `finance.read`; saving card visibility and seeing the hidden card disappear; running a real export end to end through Supabase Storage (upload, download, verify button); payroll settings form, staff card and exported workbook with a sixth band.

## 7. Organization / branch / capability / RLS checks

- Organization: derived from the session in every export RPC and the dashboard RPC; the dashboard action compares the browser-held id only as a stale-write guard; export actions accept no organization at all. Cross-tenant: owner of org B cannot read, drive, cancel, list, or fetch the manifest/chunks/storage of org A's job (all tested); B's own run returned only B rows.
- Capability: dashboard writes need `settings.manage` (manager passes, reader and non-member `42501`, anon `42501`); export needs business-owner membership, which `settings.manage` alone does not confer (tested with a Manager who holds `settings.manage`).
- Branch: export is organization-wide by design (owner only). Dashboard metrics keep the existing branch plan; with no branch grant, branch-owned metrics are `null` (restricted), only the organization-wide customer count reads.
- RLS/privileges: bookkeeping tables closed to client roles; Storage policies verified with RLS enabled on the stub table (owner reads/writes own `exports/` prefix, owner cannot write another org's prefix or outside `exports/`, manager and other tenant read nothing, bucket private).

## 8. Explicitly deferred (not built)

Custom fields; coat profile / wash counter; WhatsApp queue / delivery log; cross-entity audit and reconciliation views; full backup/restore and a restore drill; scheduled cleanup of old/cancelled export folders; monitoring and recovery UI; per-organization database-byte accounting; acquisition ROI. Also not done: updating `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md` (row 1 card visibility, row 38 export, row 21 size bands are now further along but remain **Partial**; I left the owner-facing audit unchanged).

## 9. Defects still blocking release

1. No browser or real-Supabase QC (section 6); the Storage upload/download path in `org-export.ts` is covered only by contract tests plus the RPC SQL tests, never against real Storage.
2. ~~GATE 7d fails on vanilla PG16~~ resolved in the follow-up (section 10): the fixture wrote `organizations` as `authenticated` after a migration revoked that; the unmodified gate script now prints `ALL GATES PASSED`.
3. Export finalize re-downloads and re-hashes every chunk inside a single server action; a very large organization may hit the function time limit (the step is idempotent and resumable, but unmeasured). The populated rehearsal exported only 7 rows.
4. The allowlist is a reviewed subset (e.g. no `grooming_jobs`, bank accounts, inventory); the archive is not a complete copy of an organization and has no restore path.
5. `payroll_eligible_pets` / `payroll_transport_shares` keep `search_path = app, public` (internal only).
6. `payments.metadata`/`external_ref` and similar free-form JSON columns are exported as stored; the column-name scan cannot prove free-form JSON content is free of provider secrets. Owner review of real data is advised before relying on the archive externally.
7. Payroll: browser QC, payslip/`perDogDetail` display on the staff card for older results, and guards on the remaining unguarded payroll read helpers remain from the Bundle 4 deferral list.

## 10. Follow-up: export completeness flaw (reviewer finding P1) and unmodified full gate run

**Flaw (confirmed):** `org_export_finish_table(job, table, NULL)` marked a populated table complete without reading it, and `org_export_complete` then accepted a zero-chunk manifest; `org_export_record_chunk` trusted client counts/ranges. An archive could pass its own verifier while omitting data.

**Fix** (`20261028100000_org_export_foundation.sql`, edited in place, still unapplied):
- `org_export_finish_table` now locks the state row, requires the supplied cursor to equal the recorded cursor, and refuses with `22023 export_incomplete` if **any** tenant row has `id >` that cursor (checked against the source table, with the job's organization).
- `org_export_record_chunk` now recomputes the next bounded server page after the stored cursor (`order by id limit p_row_count`) and requires the claimed row count, first id and last id to equal it exactly, else `22023 invalid_chunk`. Skipped, shifted, fabricated, inflated or understated ranges cannot be recorded; a refused call does not advance the cursor. Idempotent replay of an already recorded chunk is unchanged. (The SHA-256 is still supplied by the web server because the file bodies live in Storage; it is checked by the verifier, which re-reads every file.)
- Consequence: because every table must be finished against the live source, a manifest with zero chunks for a populated table can no longer be produced.

**New SQL regressions** (`supabase/tests/20261028100000_test_org_export.sql`): early `finish_table(..., NULL)` on a populated table refused; finishing after the first chunk while row 103 remains refused; four fabricated/skipped ranges refused (skipped first row, fabricated last id, inflated count, understated count hiding a row) and the cursor verified unmoved; tenant B's own export loop now exports real pages before finishing. Mutation check: restoring the old `finish_table` makes the test fail with `FAIL early completion of a populated table: expected 22023:export_incomplete, got ok`. A static TS test pins both checks in the migration text.

**GATE 7d (no longer skipped):** `integration/retention_renewal_followups_smoke.sql` line 581 updated `public.organizations` as `authenticated`, but migration `20261019100000` revokes INSERT/UPDATE/DELETE on that table from `authenticated`. The fixture statement now runs after `reset role` and restores `set local role authenticated` (4 added lines, no assertion changed). This is the cause of the "known baseline failure".

**Verification after the fix** (logs in `logs/CONTROL-PLANE/`):
- `run_all_gates.sh` run **unmodified** (only CRLF stripped from `*.sh`, as on any Windows checkout) from a clean copy against a fresh PostgreSQL 16.15 container: GATE 1 (`npm ci`, strict typecheck `exit=0`), GATE 2 (workspace build), GATE 3 (`# tests 129`, all pass), GATE 4 to 8 including 7d and 7m, then `ALL GATES PASSED` / `EXIT 0` ([full-gates-unmodified-run.log](logs/CONTROL-PLANE/full-gates-unmodified-run.log)). The container had Supabase-style default grants on `template1`; `psql`/`createdb`/`dropdb` were thin shims into the container (Windows has no PG client).
- Export and dashboard SQL tests: all PASS inside that run (GATE 4b).
- Populated-upgrade rehearsal re-run: `POPULATED UPGRADE PASS`, `ORGANIZATION EXPORT POPULATED PASS (7 rows across 42 allowlisted tables, every count equals the organization's own)` ([log](logs/CONTROL-PLANE/populated-upgrade.log)).
- Web: full suite `ℹ tests 566 / pass 566 / fail 0`; `tsc --noEmit` clean.

**Tree caveats you should know about:**
- Other work landed in the tree while I worked: commits `25f150e` and `45fc289` (export verifier, dashboard cards) already contain my earlier version of this batch; an untracked `20261029100000_custom_fields.sql` + `test_custom_fields.sql` and `src/lib/custom-fields.ts` appeared (not mine, not in `EXPECTED_MIGRATIONS`, so the unmodified gate script correctly refuses a tree containing them: "Migration lineage mismatch"). I ran the gates and rehearsal on a copy **excluding those two custom-fields SQL files** and did not touch them. `eslint --max-warnings=0` currently reports one warning, in that file (`custom-fields.ts:58`, unused eslint-disable); my files are clean. Customer 360 pet-edit files were also being edited concurrently; the full web suite passed with them as they stood.
- Remaining blockers from section 9 still apply except #2: no browser/real-Storage QC, large-organization finalize timing, partial allowlist/no restore, internal `search_path` leftovers, free-form JSON content.
