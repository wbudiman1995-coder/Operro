# Release sequence: final parity operations (13 October 2026)

For owner and reviewer. Nothing here was executed against a hosted environment. Commit under test: `2b8d3be6368c3d495a971154c6688f4f8a8789e3` (the branch tip adds documents and logs only).

## 1. Migrations (database first)

Apply in this order, once each, after `20261031160000_health_signals.sql`. Each file is its own transaction and depends only on earlier ones.

| Order | File | Depends on |
|---|---|---|
| 1 | `20261101100000_marketing_spend_roi.sql` | dashboard, finance, customers |
| 2 | `20261101110000_cash_account_mappings.sql` | cash register (20261031110000), payments, refunds, expenses, financial ledger |
| 3 | `20261101120000_whatsapp_provider_boundary.sql` | business owner helper, audit trigger |
| 4 | `20261101130000_export_scope_stream_tables.sql` | export scope (20261031130000), files 1 and 2 |
| 5 | `20261101140000_business_defaults.sql` | file 1 (`normalize_source_key`), export specs |
| 6 | `20261101150000_access_readiness.sql` | platform invitations, memberships |
| 7 | `20261101160000_recovery_evidence_cleanup_signals.sql` | health recovery, storage cleanup, export jobs |

`select app.schema_version();` must return `20261101160000` afterwards. It is what `apps/web/src/lib/health.ts` expects.

## 2. Deploy steps

1. **Staging database:** apply the seven migrations; run `docs/runbooks/staging_access_checks.sql` (read-only) and note the output.
2. **Staging web:** deploy the branch build after step 1; run the manual checks in section 4.
3. **Production database:** apply the seven migrations. The previous web build keeps working against the new schema (additive changes only).
4. **Production web:** deploy the new build **after** step 3. If the web build goes live first, the new pages call RPCs that do not exist and the health page reports a schema mismatch.
5. Do not set any platform flag, create a restore marker, register a service identity or enable a provider: none of those is part of this release.

## 3. Rollback by forward migration

Never edit or drop an applied migration, never delete from an immutable table, never restore over a populated tenant.

| Problem | Forward fix |
|---|---|
| Web regression | Redeploy the previous web build (schema changes are additive; replaced functions kept their old result keys). |
| A new RPC misbehaves | New migration: `revoke execute on function ... from authenticated`; remove the page link in the web build. |
| Wrong spend entry | Record a reversal (it carries the original day). |
| Wrong cash mapping | Add a newer mapping or a stop mapping with a later effective date; history stays. |
| Wrong business defaults | Save new defaults; existing invoices and customers were never changed. |
| Archive scope too broad | New migration removing the row from `app.organization_export_table_specs`; existing archives are unaffected. |
| WhatsApp gate | Leave `whatsapp_provider_available` false; no code can change it. |
| Restore marker | `public.operro_restore_target` must never exist in production; no migration creates it (a test enforces it). |

## 4. Checks around the release

**Local (already run on the branch tip, repeat on the release candidate):** web test suite, web and root typecheck, zero-warning lint, production build, `git diff --check`, `run_all_gates.sh` (GATE 1 to 9), `integration/run_populated_upgrade_rehearsal.sh`. Results and logs: `docs/handoffs/logs/FINAL-PARITY-OPERATIONS/`.

**Hosted staging (not done):**
1. Open each new page as owner, Admin and a restricted helper: `/dashboard` (return table), `/finance/marketing`, `/finance/register` and `/finance/register/mapping`, `/settings/business`, `/settings/whatsapp-provider`, `/settings/health` (as platform owner and as business owner), `/platform` (readiness panel). Check a phone-width layout; none was checked.
2. Run `docs/runbooks/STAGING_ACCESS_QC.md` with real mailboxes you control, then `staging_access_checks.sql`.
3. Export an archive on staging with real Storage, verify it, then follow `docs/runbooks/DISPOSABLE_RESTORE_DRILL.md` kind C into a disposable database, and record the drill on `/settings/health` with the printed hashes. Record it as `partial`.

**Manual owner checks after production release:**
1. Dashboard: record one small spend in a test source and confirm the return row and that it carries no ratio before spend exists.
2. Finance register: create one account, declare an opening balance at the mapping's effective date, map one payment method, and compare the position with the payment list; confirm the card or unmapped payments appear under "Arus yang tidak masuk saldo".
3. Settings: save business defaults and open a new invoice to see the due date pre-filled; confirm an older invoice did not change.
4. `/settings/whatsapp-provider` says "Belum tersedia" and offers no enable control.
5. Health: read the last preview and completed cleanup lines; leave cleanup consent off.

## 5. External decisions and set-up that remain (owner only)

See [OWNER-DECISIONS-AND-CREDENTIALS.md](OWNER-DECISIONS-AND-CREDENTIALS.md). Until they are taken, keep the classification: WhatsApp, access readiness and recovery Partial; storage automation Blocked; no full parity claim.
