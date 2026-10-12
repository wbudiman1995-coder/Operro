# Release sequence: final parity closeout (12 October 2026)

For review by the owner and Codex. Nothing in this document was executed against a hosted environment.

## 1. Migration order

Apply in this order, each exactly once, after `20261030100000_performance_dashboard.sql`. Each file is its own transaction and depends only on earlier ones.

| Order | File | Depends on |
|---|---|---|
| 1 | `20261031100000_dashboard_operational_alerts.sql` | performance dashboard, storage cleanup, org export tables (read only) |
| 2 | `20261031110000_cash_control_register.sql` | finance tables |
| 3 | `20261031120000_whatsapp_batch_log.sql` | WhatsApp drafts |
| 4 | `20261031130000_export_scope_retention.sql` | org export (20261028) |
| 5 | `20261031140000_business_settings.sql` | branches |
| 6 | `20261031150000_cleanup_schedule_consent.sql` | storage cleanup (20261029) |
| 7 | `20261031160000_health_signals.sql` | 4 and 6 (`health_summary` reads both) |

Each migration redefines `app.schema_version()`; the final value is `20261031160000`, which `apps/web/src/lib/health.ts` (`EXPECTED_SCHEMA_VERSION`) and the drift test expect. Do not deploy the web build with a lower migration applied: the health page would report a version mismatch, which is correct behavior.

**Deploy migrations before the web build.** The dashboard card-settings form now submits eight card keys and the new pages call RPCs that do not exist until their migration is applied.

## 2. Rollback: forward fix only

Do not edit or delete an applied migration and do not restore over a populated tenant. If something is wrong:

- Web only: redeploy the previous web build. The old build tolerates every new table and column (all additive); the one exception is the dashboard settings form, which an old build posts with four or seven keys, still accepted by the replaced `update_dashboard_card_settings` (optional key keeps its stored value).
- Database: ship a new migration with a later timestamp. For example, to stop a misbehaving alert or batch action, `revoke execute` from `authenticated` in a forward migration; to hide a surface, remove the navigation entry in the web build. The cash and WhatsApp event tables are immutable by design: do not try to delete rows, post a reversal (cash) or a cancel (WhatsApp) instead.
- Never drop the new tables once rows exist; they hold audit history.

## 3. Checks before release

### Local (already done, repeat on the release candidate)

1. `npm run typecheck` (web), `npx tsc -p tsconfig.typecheck.json --noEmit` (root), `npm run lint -- --max-warnings=0`, `npm run build`, and the web test suite (`npx tsx --test test/*.test.ts test/*.test.tsx` in `apps/web`).
2. `run_all_gates.sh` on PostgreSQL 16 and `integration/run_populated_upgrade_rehearsal.sh` (needs docker).
3. Last run recorded in `docs/handoffs/logs/FINAL-PARITY-CLOSEOUT/`.

### Hosted staging (not done: required before production)

1. Apply the seven migrations to a staging project that holds a copy or sample of realistic data (not production). Confirm `select app.schema_version()` returns `20261031160000`.
2. Run the PostgreSQL role tests of the new migrations against staging if a read-write test schema is available; otherwise rely on the local run and review the grants with `\df+ app.*` for the new functions (execute for `authenticated` only, none for `anon`).
3. Run `docs/runbooks/STAGING_ACCESS_QC.md` (real invitation, wrong-account claim, multi-organization switching, suspended workspace, Admin checklist denial, helper role denial).
4. Run an export in staging against real Storage, verify it, then run `apps/web/scripts/verify-org-export.ts` on the downloaded files and follow `docs/runbooks/DISPOSABLE_RESTORE_DRILL.md` into a **disposable** project, filing `RESTORE_DRILL_EVIDENCE_TEMPLATE.md`. Skip nothing and do not point it at production.
5. Open each new page as owner, Admin and a restricted helper: `/dashboard` (alerts), `/finance/register`, `/whatsapp/batches`, `/settings/business`, `/settings/storage` (consent, scope, purge), `/settings/health`. Check mobile width (not yet checked anywhere).

### Manual owner checks after release

1. Dashboard: confirm each alert's number against the linked page for one branch.
2. Finance register: create one account in a test branch, post an opening balance and a reversal; confirm the position and that no payment moved it.
3. WhatsApp: create a batch from two invoices, open one draft, report outcomes, cancel the other; confirm the history and that nothing was sent from Operro.
4. Business: change one branch's calendar hours, reload on a second session to see the conflict message appear on a stale save.
5. Storage: leave cleanup consent **off** unless a runner exists; confirm the page says none does.
6. Health: confirm each open item names an action and that an Admin sees the restricted state.

## 4. External decisions still required

| Decision | Blocks | Owner / Platform |
|---|---|---|
| Marketing spend model (who records, per source/period/branch) | Source ROI on the dashboard (#1) | Owner |
| Payment-to-account mapping, payroll payout recording, bank reconciliation | Truthful cash on hand and any ledger claim (#31) | Owner and accountant |
| Official WhatsApp provider, credentials, consent text, webhook and staging account | Delivered/read status (#34) | Owner |
| Importer scope and who runs disposable restore drills | A real restore claim (#38, #44) | Owner / platform |
| Adopt or decline `sourceLabels` and `dueDayDefault` | Closing #39 | Owner |
| Hosted staging run of the invitation flow | Closing #41 | Owner |
| Scheduler choice and service-identity model | Any unattended cleanup (#43) | Platform |

Until these are decided, keep the wording in the proposal: partial, not full parity.
