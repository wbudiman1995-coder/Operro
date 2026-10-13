# Final parity operations handoff

Date: 13 October 2026 (Asia/Jakarta). Branch `claude/final-parity-operations`, base `c825aab` (production baseline). Design written first: [docs/agent-work/FINAL-PARITY-OPERATIONS-DESIGN.md](../agent-work/FINAL-PARITY-OPERATIONS-DESIGN.md).

**Code under test: `2b8d3be6368c3d495a971154c6688f4f8a8789e3`.** Every check below was run against that exact code (the tree was clean at `2b8d3be`; the only later commit adds this handoff, three other documents, a `.gitattributes` line and the evidence logs, no code). Full file list: [changed-files.txt](logs/FINAL-PARITY-OPERATIONS/changed-files.txt) (89 files, 53 added).

**Not done anywhere:** no hosted Supabase or Vercel project, no real WhatsApp provider, no real mail, no invitation, no production restore, no real record and no secret was touched. Everything ran on local PostgreSQL 16 containers and a private local Supabase CLI stack with synthetic data. Nothing was pushed, deployed or applied remotely.

## 1. Stream status (honest classification)

| # | Stream (parity row) | Status | What is true |
|---|---|---|---|
| 1 | Dashboard marketing spend and ROI (#1) | **Implemented** (code and local proof) | Immutable manual spend ledger, `/finance/marketing`, `app.dashboard_source_roi` and a return table in the dashboard sources card. ROI = cash collected in the period from customers created in the same period under that source, minus refunds, divided by recorded net spend, per source and currency; no ratio without spend; not lifetime value or profit. Needs the owner to accept that attribution rule (D1). |
| 2 | Financial operations: cash on hand (#31) | **Implemented** as a mapped cash-control position, **not** a ledger or bank reconciliation | Immutable effective-dated mappings (payments by method, expenses, payroll paid to accounts), `app.cash_on_hand`, `app.cash_unmapped_flows`. Unmapped, other-currency and already-declared flows are listed, never dropped. Needs the owner's mappings and opening balances (D2). |
| 3 | WhatsApp official-provider boundary (#34) | **Partial** | Disabled-by-default boundary only: platform gate seeded `false` that no function can change, owner settings that cannot enable, pure Meta adapter helpers with tests, setup runbook. Operro still sends nothing and stores no delivered or read state. Stays Partial until a real official provider, consent, credentials, webhook and staging test exist (D3). |
| 4 | Disposable-target restore/import (#38) | **Implemented** as tooling with local PostgreSQL proof; row #38 stays **Partial** | `restore-org-export.ts` generates one self-guarding SQL transaction. Proven on real PostgreSQL 16: exact load, refusal of every unsafe target, full rollback on a late failure, tenant containment, immutable history preserved. No restore was run on any hosted or real disposable project; Storage bodies, Auth identities and secrets are not in the archive (D4). |
| 5 | Business settings (#39) | **Implemented** | Typed `organization_business_defaults`: suggested source labels (customer source stays free text) and a default invoice due period that only pre-fills new invoices. Currency and platform billing remain deliberately outside business control (D5). |
| 6 | Accounts and multi-organization readiness (#41) | **Partial** | `app.access_readiness_summary` (platform owner only, counts and flag codes, no e-mail/token/user id), a panel on `/platform`, a read-only staging post-condition script tested against deliberately wrong data, updated staging QC runbook. Stays Partial until the hosted real-mail invitation QC is run (D6). No invitation was created and no mail sent. |
| 7 | Storage maintenance automation (#43) | **Blocked** | No runner was built: the repository has no scheduler and no service identity. The proposed identity model and runner contract are specified in `UNATTENDED_CLEANUP.md`; the health page now reports last preview, last completed apply and unapplied preview candidates. Blocked until a scheduler and service identity are chosen (D7). |
| 8 | Reliability and recovery proof (#44) | **Partial** | Drill records carry a kind and archive manifest/report hashes; the database sets `evidence_matches_export` only when a completed export has that exact manifest hash. Archive-based drills can never be recorded as passed. Nothing reads Supabase backup or PITR status. Stays Partial until a real hosted or disposable restore drill is recorded (D8). |

**Full HomePaw parity is not claimed.** See the parity proposal.

## 2. Commits since `c825aab`

```
be18634 docs: design final parity operations streams
ba6c165 test: stop pinning the schema version in two upgrade tests
9696dec feat(dashboard): marketing spend ledger and a defined source return
55e83dd feat(finance): cash account mappings and a mapped cash-on-hand position
944e069 feat(whatsapp): disabled official-provider boundary
c5b7c08 feat(export): guarded restore-script generator for a disposable target
155bec8 feat(settings): typed business defaults for source labels and invoice due period
873db95 feat(access): platform access readiness summary and staging post-condition checks
7ab6ea9 feat(reliability): verifiable restore-drill evidence and record-backed cleanup signals
2b8d3be test: populated-upgrade probe for the operations migrations
```

`ba6c165` fixes a defect found at the baseline: `supabase/tests/20261030110000_test_payroll_read_helper_hardening.sql` required `app.schema_version()` to equal its own migration, so the baseline gate suite failed at `c825aab` as soon as any later migration existed (baseline run: exit 3, `FAIL: schema version 20261031160000`, [baseline-db-gates.log](logs/FINAL-PARITY-OPERATIONS/baseline-db-gates.log) holds the passing re-run after the fix). The same pin in `integration/final_closeout_upgrade_probe.sql` was relaxed to `>=`. Baseline web suite before any change: 715/715.

## 3. Migrations (apply in this order, forward-only, none edits an existing migration)

| Order | File | Stream |
|---|---|---|
| 1 | `20261101100000_marketing_spend_roi.sql` | 1 |
| 2 | `20261101110000_cash_account_mappings.sql` | 2 |
| 3 | `20261101120000_whatsapp_provider_boundary.sql` | 3 |
| 4 | `20261101130000_export_scope_stream_tables.sql` | 4 (adds the spend ledger and mappings to the archive scope; provider settings stay out as sensitive) |
| 5 | `20261101140000_business_defaults.sql` | 5 (also adds the defaults table to the archive scope) |
| 6 | `20261101150000_access_readiness.sql` | 6 |
| 7 | `20261101160000_recovery_evidence_cleanup_signals.sql` | 7 and 8 |

Every new `SECURITY DEFINER` function has `search_path = ''`, validated narrow inputs, explicit `revoke ... from public, anon, authenticated` then `grant execute ... to authenticated`, a tenant/capability check and a PostgreSQL role test. `app.schema_version()` is redefined by each file; the final value `20261101160000` equals `EXPECTED_SCHEMA_VERSION` in `apps/web/src/lib/health.ts` (a test fails on drift).

## 4. Checks run against `2b8d3be` (exact commands and unedited results)

All logs are in `docs/handoffs/logs/FINAL-PARITY-OPERATIONS/`.

| Check | Command | Result | Log |
|---|---|---|---|
| Full web suite | `npx tsx --test test/*.test.ts test/*.test.tsx` (in `apps/web`) | 785 tests, 784 pass, 0 fail, 1 skipped (the restore rehearsal, which needs a database and is run separately below) | `web-all-tests.log` |
| Web typecheck | `npm run typecheck` (in `apps/web`) | exit 0 | `typecheck-lint.log` |
| Zero-warning lint | `npm run lint -- --max-warnings=0` (in `apps/web`) | exit 0 | `typecheck-lint.log` |
| Root typecheck | `npx tsc -p tsconfig.typecheck.json --noEmit` | exit 0 | `typecheck-lint.log` |
| Production build | `npm run build` (in `apps/web`) | exit 0; new routes `/finance/marketing`, `/finance/register/mapping`, `/settings/whatsapp-provider` built | `build.log` |
| `git diff --check` | `git -c core.whitespace=cr-at-eol diff --check c825aab..HEAD` | clean except raw psql padding in the committed `baseline-db-gates.log`; fixed by a `.gitattributes` line (`-whitespace`) in the documentation commit, the repository's existing convention for log files. Plain `git diff --check` also reports the carriage returns of CRLF working-tree files. | `diff-check.log` |
| run_all_gates GATE 1-3 | `run_all_gates.sh` up to GATE 4, run on the host (strict typecheck, workspace build, in-memory tests) | exit 0; 359 tests, 359 pass | `gates-1-3.log` |
| PostgreSQL gate suite | `run_all_gates.sh` GATE 4 to 8b, unmodified text, in a fresh `postgres:16` container with real `anon`/`authenticated`/`service_role` roles (`tools` harness outside the repository) | `ALL GATES PASSED`, `GATES_EXIT=0`, 1,596 `NOTICE: PASS` lines | `db-gates.log` |
| Populated-upgrade rehearsal | `integration/run_populated_upgrade_rehearsal.sh` (docker) | `POPULATED UPGRADE PASS`; `FINAL OPERATIONS POPULATED PROBE PASS`. Probe notices: ROI window 2025-10-13..2026-10-13, 3 currency/source rows, cohort customers 7, collected IDR 710,000.00; mapping probe: mapped cash payments 240,000.00, unmapped other-method payments 470,000.00 (all equal to independent queries) | `populated-upgrade.log`, `populated-upgrade.stdout` |
| Restore rehearsal (GATE 9) | `RESTORE_REHEARSAL_PSQL='["wsl","-d","Ubuntu","--","docker","exec","-i","ops-pg16","psql","-U","postgres"]' RESTORE_REHEARSAL_TEMPLATE=tpl npx tsx --test test/restore-import-rehearsal.test.ts` | 13 tests, 13 pass, 0 fail | `restore-rehearsal.log` |

Per-migration SQL role-test assertion counts in `db-gates.log`: spend/ROI 72, cash mappings 78, WhatsApp boundary 40, business defaults 44, access readiness 35, recovery evidence 50.

How the harness differs from a CI run of `run_all_gates.sh`: the PostgreSQL part ran in docker through WSL with GATE 1 to 3 run separately on the host and GATE 9 (a Node test that talks to PostgreSQL) run on the host against the same PostgreSQL 16 image through `docker exec`. The script as committed ends with GATE 9 so one invocation covers all of it where Node and PostgreSQL share a host; that combined single invocation was not run here. PostgreSQL 16 was the engine for the gates; the browser stack used the Supabase CLI's PostgreSQL 17 image, and all migrations applied from scratch on both.

No check failed against the final code. Two defects were found and fixed earlier in the work (not at the end): the baseline schema-version pin above, and a populated-upgrade probe that first passed vacuously on the empty HomePaw workspace (now fails unless its synthetic cohort is present).

## 5. Browser coverage (local stack only) and gaps

Local Supabase CLI stack, synthetic accounts (owner, tenant Admin, restricted helper, a second workspace, a local test platform owner), local test password. The browser window was hidden so screenshots timed out; observations are DOM text read through the page tools, and **no screenshots are attached**.

Checked as the Alpha workspace **owner**:
- Dashboard before any spend: the sources card said ROI per source is unavailable and linked to the spend page.
- `/finance/marketing`: recorded one Instagram spend of 100,000 IDR; ledger and definition text rendered.
- Dashboard after spend: return table showed Instagram spend 100,000, 4 new customers / 2 paying, net revenue 280,000, result 180,000, ratio 2.80×; Teman and Google revenue rows showed "Tidak dicatat" and no ratio.
- `/finance/register`: created two accounts (organization-wide cash, a branch bank account). `/finance/register/mapping`: saved three mappings (cash payments, expenses, bank transfers at the main branch). The mapped position then showed BCA 350,000 and Kas toko 280,000 payments less 250,000 expenses = 30,000, and listed the unmapped card payment of 120,000.
- `/settings/business`: saved the defaults (labels, 7 days; version became 1). `/invoices/new` then pre-filled invoice date 2026-10-13 and due date 2026-10-20. `/customers` rendered the suggestion list (Instagram, Teman, Google, Booking chat).

**Browser gaps (not checked in a browser):** the WhatsApp provider settings page, the platform readiness panel on `/platform`, `/settings/health` with the new drill form and cleanup signals, spend reversal and cash-account archive flows, the customer detail and onboarding source suggestions, every restricted-role view of the new pages (Admin, helper), cross-tenant views, and any mobile width. Those surfaces are covered by web unit/render tests and SQL role tests only.

## 6. Safe deployment order

1. Review and apply the seven migrations to **staging** first, in the order above, and confirm `select app.schema_version();` returns `20261101160000`.
2. Production database: apply the seven migrations (no web change needed to apply them; the old web build keeps working, see rollback notes).
3. Production web: deploy the new build **after** the migrations. Deploying the web build first would call RPCs that do not exist yet, and the health page would report a schema mismatch.
4. Owner-only external setup is separate and optional (see the decisions document): nothing in this batch needs an external service to be turned on.

## 7. Rollback by forward migration

Never edit or drop an applied migration; never restore over a populated tenant. Immutable tables (`marketing_spend_entries`, `cash_account_mappings`, `cash_movements`, `whatsapp_draft_events`, `recovery_drills`) must not be emptied: correct with a reversal row or a newer mapping.

- **Web only problem:** redeploy the previous web build. All schema changes are additive; the old build ignores the new tables and the replaced functions keep their old signatures and result keys (`recovery_status`, `health_summary`, `update_dashboard_card_settings`, `org_export_scope` only gained fields or one classification).
- **A misbehaving new RPC:** ship a forward migration that `revoke execute ... from authenticated` on it (spend, mapping, defaults, provider settings, readiness, drill-evidence recorder), and hide its page by removing the navigation link in the web build.
- **Wrong spend or mapping:** reverse the spend entry; add a newer mapping (or a stop mapping) with a later effective date. History stays.
- **Wrong business defaults:** save new defaults; they never touched existing invoices or customers.
- **Archive scope:** a forward migration can remove a row from `app.organization_export_table_specs`; existing archives are unaffected.
- **Platform gate** `whatsapp_provider_available`: it is seeded `false` and no function changes it; leave it false.
- **The restore marker** `public.operro_restore_target` is never created by a migration (a test asserts this) and must never exist in production.

## 8. Limitations and risks to review

1. SECURITY DEFINER readers (`dashboard_source_roi`, `cash_on_hand`, `cash_unmapped_flows`, `access_readiness_summary`) bypass row-level security and re-implement tenant and branch checks; the SQL suites are the guard if branch policies change.
2. The ROI uses the customer's current source and cash collected in the same period; late payers are not counted. It is labelled as such.
3. The mapped cash position is only as true as the mappings and declared opening balance; backdating a first mapping recomputes history (later mappings for the same key cannot be dated earlier).
4. The restore script needs a database role that may set `session_replication_role`; it was proven on the local PostgreSQL superuser role, not on a hosted role. The organization row in the target must be created with triggers bypassed (the marker script does this).
5. Local gate harness details in section 4.

## 9. Owner decisions required

See [docs/OWNER-DECISIONS-AND-CREDENTIALS.md](../OWNER-DECISIONS-AND-CREDENTIALS.md). Related documents: [parity proposal](../HOMEPAW_PARITY_AUDIT_PROPOSAL_2026-10-13.md), [release sequence](../RELEASE_SEQUENCE_FINAL_PARITY_OPERATIONS.md).
