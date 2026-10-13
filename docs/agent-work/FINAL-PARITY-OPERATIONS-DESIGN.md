# Final parity operations: design (written before implementation)

Date: 13 October 2026 (Asia/Jakarta). Branch `claude/final-parity-operations`, base `c825aab` (production baseline: deployed Vercel build and Supabase schema match it). Brief: the owner's 13 October request, which continues `docs/agent-work/CLAUDE-FINAL-PARITY-CLOSEOUT-20261012.md`.

Local work only. No push, deploy, remote migration, secret access, mail or message, and no real record is created. Browser checks use a private local Supabase CLI stack with synthetic data.

## Scope decisions (what this program will and will not build)

| # | Stream | Decision | One-line reason |
|---|---|---|---|
| 1 | Dashboard ROI | **Build** a spend ledger and a defined, labelled ROI | A tenant-owned immutable spend model plus a fixed attribution rule can be stated truthfully per currency |
| 2 | Cash on hand | **Build** account mappings and a mapped cash position | Existing authoritative rows (payments, refunds, expenses, payroll ledger) can be mapped to accounts from an explicit effective date |
| 3 | WhatsApp provider | **Boundary only** (disabled by default, nothing can send) | Needs Meta account, credentials, consent and a webhook identity that do not exist |
| 4 | Restore/import | **Build** a guarded, dry-run-first SQL generator for a disposable target, with a real database test | Can be made safe by construction and proven locally; hosted drill stays an owner action |
| 5 | Business settings | **Build** source labels and invoice due-date default | Both are unambiguous when they only suggest or pre-fill |
| 6 | Accounts readiness | **Build** a platform readiness summary and a read-only verification script | Real invitations and mail stay out of scope |
| 7 | Storage automation | **Do not build a runner**; improve operator path | The repository has no scheduler or service identity; the model is specified, not shipped |
| 8 | Reliability | **Build** verifiable restore-drill evidence and record-backed signals | A drill can reference a real archive manifest hash; backup/PITR status is never faked |

## Shared definitions

- **Service identity.** There is none in the repository today (no service-role client in the web app, no cron route, no `vercel.json` crons, no pg_cron). Streams 3 and 7 both need one. This program does **not** introduce a service-role key into the web app. The specified model (stream 7, owner decision D7) is a dedicated Supabase Auth user registered by the platform owner, using an ordinary authenticated JWT and RPCs gated by a registry, never the service-role key.
- **Immutable and reversible.** Money-bearing records added here follow the existing `cash_movements` pattern: insert-only, a trigger refuses UPDATE/DELETE even for the table owner, a mistake is corrected by a reversal row, idempotent by `request_key`.
- **Security definer rule.** Every new definer function sets `search_path = ''`, validates narrow inputs, takes the organization only from `app.fn_active_organization()`, checks membership and capability, and has explicit `revoke all ... from public, anon, authenticated` followed by `grant execute ... to authenticated`. Each has a PostgreSQL role test with real `authenticated`/`anon` roles.
- **Currencies** are never summed, converted or netted. Every figure is per currency.
- **Wording.** A status is what it is: a measure, a user report, a mapped position. Nothing is called profit, accounting, bank reconciliation, delivered, read, backed up or restored unless the record supports it.

## Design table

### Stream 1: Dashboard marketing spend and ROI (#1)

| Field | Content |
|---|---|
| Current behavior | `app.dashboard_source_performance` returns counts per normalized source (new customers, first completed, first paid). No amounts. The UI states ROI is unavailable. Five operational alerts exist (20261031100000). |
| HomePaw behavior | "Source ROI" shows revenue and lifetime value per source; HomePaw keeps no spend, so it is not a cost return either. |
| Proposed scope | (a) `marketing_spend_entries`: org-wide, per source label, date, amount, currency, optional note; immutable, reversal-only correction, idempotent. (b) `app.dashboard_source_roi(from, to, timezone)`: for each source and currency, the recorded net spend in the period, the **cohort revenue** (succeeded payments minus succeeded refunds, by payment/refund date inside the period, from customers whose `created_at` falls in the same period and whose current source normalizes to that key), net result and ratio. Ratio is shown only when spend is greater than zero. (c) A `/finance/marketing` page to record and reverse spend and a table in the dashboard sources card. |
| Attribution rule (fixed, stated on screen) | Source is the customer's **current** stored source, as in the accepted sources card. Cohort = customers created in the period. Revenue = cash actually collected in the same period, not lifetime value and not revenue recognized by invoice date. A source with spend but no cohort revenue returns revenue 0. Customers with no source are never given spend. |
| Risks | Cohort revenue understates return for customers who pay after the period; source is editable free text (normalization groups case and spacing only). Mitigation: the label says "pendapatan periode dari pelanggan baru periode ini", not ROI of a campaign; no ratio without spend; mismatched currencies never combined. |
| Owner decisions | D1: accept the cohort-in-period rule, or require a longer attribution window (for example 90 days) as a later change. Who is allowed to record spend (default: `finance.manage`). |
| Migration | `20261101100000_marketing_spend_roi.sql` (table, immutability trigger, three RPCs, `app.normalize_source_key`, `schema_version`). |
| Authorization | Write: `finance.manage` + finance module + `branches.all` (spend is organization-wide). Read spend and ROI: `finance.read` + `customer.read` + crm and finance modules + `branches.all` + not a Groomer member (same as the accepted source card). Denied card makes no query. |
| Tests | SQL: immutability (including table owner), reversal rules, idempotent replay, per-currency separation, ratio absent without spend, cohort boundary on the Jakarta day, refunds subtracted, cross-tenant, branch-restricted denial, anon, direct DML denied. Web: parser, formatter, empty/denied/error states, wording test that "ROI" is never shown without spend. |
| Non-goals | Campaign-level attribution, lifetime value, multi-touch, currency conversion, ad-platform import, branch-level spend. |

### Stream 2: Financial operations toward cash on hand (#31)

| Field | Content |
|---|---|
| Current behavior | Cash-control register (20261031110000): accounts and immutable declared movements, reversal, per-account per-currency position. Payments, refunds, expenses and payroll do not post to it. `app.finance_cash_position` is a separate read-only report. |
| HomePaw behavior | "Kas tersedia" = capital minus expenses minus salaries paid (single pool, no accounts). |
| Proposed scope | `cash_account_mappings`: immutable versioned rows saying that from an **effective date**, payments with method M at branch B (or any branch) are received into account A; refunds follow the method of their payment; expenses at branch B are paid from account A; payroll payouts at branch B are paid from account A. `app.cash_on_hand(as_of)` returns per account and currency: declared movements through the date, plus mapped payments, minus mapped refunds, minus mapped expenses, minus mapped payroll payouts (from `financial_ledger.payroll_paid`, which already carries compensating reversal entries), each counted only on or after its mapping's effective date, plus an **unmapped flows** section listing amounts the mappings do not cover, so the owner sees what the position leaves out. |
| Why this is truthful | Every term comes from an existing authoritative row and a recorded owner mapping. Opening balance is declared at the cutover date, which is the mapping's effective date; flows before it are never counted, so nothing is counted twice. |
| Risks | Wrong mapping gives a wrong position; double counting if the owner also declares manual movements for the same flow (mitigated: the screen says declared `cash_in`/`cash_out` are for flows Operro does not record). A payment recorded with a back-dated `paid_at` before the effective date is excluded by design and appears in "unmapped". |
| Owner decisions | D2: which account receives each payment method per branch; cutover date and opening balances; whether expenses are always paid from one account. |
| Migration | `20261101110000_cash_account_mappings.sql`. |
| Authorization | Mapping and position: `finance.manage` for mapping writes, `finance.read` for the position; branch grant required for branch-specific mappings; organization-wide mappings need `branches.all`. |
| Tests | SQL: each flow type mapped and unmapped, effective-date boundary, refund follows payment method, payroll reversal nets out, per-currency separation, supersede keeps history, immutability, cross-tenant, branch restriction, anon. Web: position parser, unmapped warning, wording. |
| Non-goals | Double-entry ledger, bank-statement reconciliation, profit or tax, payment-gateway settlement, currency conversion. A declared statement-balance check is **not** built; calling it reconciliation would overstate it. |

### Stream 3: WhatsApp official-provider boundary (#34)

| Field | Content |
|---|---|
| Current behavior | Drafts, batches, append-only event log of user-reported outcomes. No provider; delivered/read states do not exist. |
| HomePaw behavior | Manual `wa.me` sending with a message log. |
| Proposed scope | (a) A typed boundary in code: a `WhatsAppProvider` interface, a `disabled` provider that is the only one wired, and pure Meta Cloud API helpers (webhook signature verification with a passed-in secret, payload normalization to sent/delivered/read/failed, template-message builder), unit-tested on fixture payloads. They read no environment and make no network call. (b) `whatsapp_provider_settings`: per organization, provider `none` or `meta_cloud`, `enabled` false by default, non-secret identifiers only (phone-number id, business account id), owner attestation of customer opt-in consent. Enabling is impossible while the **platform** flag `whatsapp_provider_available` is false (it is false and nothing in this program sets it). (c) `docs/runbooks/WHATSAPP_PROVIDER_SETUP.md`: Meta app and business verification, phone number, template approval, opt-in policy, webhook verify token and app-secret handling, staging number, and the service-identity decision. |
| Risks | A boundary that looks finished can be mistaken for a feature. Mitigation: settings page states "Belum tersedia"; no send action exists; no webhook route is added. |
| Owner decisions | D3: provider and account, who holds credentials, consent wording, whether webhooks are wanted, the service identity that receives them. |
| Migration | `20261101120000_whatsapp_provider_boundary.sql`. |
| Authorization | Business owner reads and writes organization settings; the platform flag is writable only by the platform owner; both are definer RPCs with the standard checks. |
| Tests | SQL: default off, enable refused while platform flag off, attestation recorded and audited, credential-like text refused, cross-tenant, anon. Web: signature verification (valid, tampered, wrong secret, missing header), payload normalization including unknown shapes, disabled provider refuses to send, no environment access in the module. |
| Non-goals | Sending, webhook endpoint, storing credentials or tokens, delivery/read states in drafts, unofficial APIs or scraping. |

### Stream 4: Disposable-target restore/import (#38)

| Field | Content |
|---|---|
| Current behavior | Archive export, SHA-256 manifest, verifier, offline dry-run planner (`verify-org-export.ts`). No importer. |
| HomePaw behavior | JSON import of a full export. |
| Proposed scope | `apps/web/scripts/restore-org-export.ts` with `plan` (dry run, default) and `sql` (writes a restore script; never connects to a database). The script is one transaction, guarded **inside the SQL** so it is safe even if run elsewhere: it aborts unless the target has a `public.operro_restore_target` table (created by the operator for a disposable database; no migration creates it, and a test asserts none does) holding `kind = 'disposable'`; unless `app.schema_version()` equals the archive's schema; unless the target holds no rows for that organization in any archived table; unless the organization row exists; and unless every row's `organization_id` equals the archive organization. It loads tables in the planner's order with `session_replication_role = replica` so immutable-history triggers are not re-fired, then **verifies inside the transaction** that per-table counts and a content hash match the archive and that every immutability trigger is still enabled, or raises and rolls everything back. It refuses unknown tables, credential-like keys and Auth/membership tables. |
| Risks | The operator could create the marker table on a real database. Mitigation: documented as the explicit act of declaring a disposable target, plus the empty-organization and schema checks; the runbook forbids production. External references (users, roles) stay dangling in the target and are reported, not invented. |
| Owner decisions | D4: who may run a drill and where; whether a self-service importer in the application is ever wanted (not proposed). |
| Migration | None (a test asserts the marker table is absent from migrations). |
| Authorization | Offline tool, no application route, no session; the SQL runs as the operator's own database role on a disposable database. |
| Tests | Node: guard text present in generated SQL, refuses tampered archive, unknown table, credential key, wrong organization row, wrong schema. Integration (docker, real PostgreSQL 16): build an archive from a populated source database, generate SQL, run it on a disposable target (success, counts and hashes match, triggers still enabled, append-only still refuses UPDATE), run again (refuses: not empty), run on a target without the marker (refuses), run with a corrupted row (rolls back, nothing loaded). Wired into `run_all_gates.sh`. |
| Non-goals | Storage object bodies, Auth identities, memberships, secrets, restoring into a live tenant, an in-app restore button, point-in-time recovery. |

### Stream 5: Business settings (#39)

| Field | Content |
|---|---|
| Current behavior | `/settings/business` maps HomePaw keys and edits branch calendar hours. `sourceLabels` and `dueDayDefault` are listed as not mapped. Source is free text; invoice due date defaults to the next day in the studio (`nextDate(today)`). |
| HomePaw behavior | `sourceLabels`: the list offered in the customer source dropdown. `dueDayDefault`: default due date for new invoices. |
| Proposed scope | `organization_business_defaults` (typed columns, one row per organization): `source_labels text[]` (≤ 20, each 1-40 characters, unique case-insensitively) and `invoice_due_days smallint` (0-365, null = studio default). `app.set_business_defaults` with optimistic concurrency on `updated_at`, audited by the existing audit trigger. Labels are **suggestions**: they populate a `datalist` in the customer form and the spend form; free text still works and the dashboard still normalizes. The due-days default only pre-fills the new-invoice form; it never changes an existing invoice and the date stays editable. |
| Risks | A closed list would break existing customers: not done on purpose. |
| Owner decisions | D5: accept suggestion-only labels (recommended) or a closed list with a migration plan for current free text. |
| Migration | `20261101140000_business_defaults.sql`. |
| Authorization | Business owner, or `settings.manage` (same as other organization-wide settings); read by any member of the organization for pre-fill. |
| Tests | SQL: validation bounds, duplicates, concurrency conflict, sibling-free typed columns, audit row, cross-tenant, anon, restricted-role denial. Web: label normalization, due-date computation in the Jakarta zone, empty and denied states. |
| Non-goals | A generic settings editor, closed source lists, retroactive due-date changes, currency changes. |

### Stream 6: Accounts and multi-organization readiness (#41)

| Field | Content |
|---|---|
| Current behavior | Invitation claim role tests (57 assertions), error messages, `STAGING_ACCESS_QC.md`. |
| HomePaw behavior | Role and owner switching. |
| Proposed scope | `app.access_readiness_summary()` for the platform owner only: per organization, counts of active members, active owners, pending/expired/revoked invitations (counts only, never a token, hash or e-mail), whether the workspace is suspended, and members that belong to more than one organization (count only). A "Kesiapan akses" block on `/platform`. `docs/runbooks/staging_access_checks.sql`: a read-only script of the post-conditions of the QC flow (no tokens, one active owner, Admin lacks roles/users management, suspended memberships stay suspended) for the operator to run on staging; QC runbook updated to reference it with an evidence table. |
| Risks | None writes data. The summary must not leak e-mails or tokens. |
| Owner decisions | D6: run the hosted QC; provide mailboxes you control. |
| Migration | `20261101150000_access_readiness.sql`. |
| Authorization | Platform owner only. |
| Tests | SQL: only platform owner, no token/hash/e-mail in the output, counts correct on a seeded case, anon. Web: rendering, restricted state. |
| Non-goals | Creating invitations, sending mail, automating the hosted QC. |

### Stream 7: Storage maintenance automation (#43)

| Field | Content |
|---|---|
| Current behavior | Dry-run-first cleanup with lease and per-object retry, owner session only; consent record, off by default; runbook. |
| HomePaw behavior | None for this (storage meter only). |
| Proposed scope | **No runner is built.** Improve the operator path: a record-backed "last cleanup" and "cleanup recommended" signal on `/settings/storage` and health from existing runs (age of the last completed preview/apply, count of items the last preview would remove), and `UNATTENDED_CLEANUP.md` revised to specify the service-identity model and the exact runner contract (claim with lease, one organization per call, dry-run then bounded apply, idempotent, audited, disabled the instant consent is switched off) so a platform decision can be implemented in one reviewed change. |
| Why no runner | A runner needs (1) a scheduler (Vercel Cron or Supabase) and (2) an identity that can act across organizations on Storage. Delete rights over other organizations' files cannot be granted safely without a decision on that identity, and no local test can prove a hosted scheduler. Shipping dead runner code would be a fake. |
| Owner decisions | D7: scheduler (Vercel Cron or Supabase scheduled function); identity (dedicated Auth user registered by the platform owner, recommended; never the service-role key in the web app); cadence and the maximum objects per run. |
| Migration | None required (read-only signals reuse stream 8's health extension). |
| Authorization | Unchanged: business owner. |
| Tests | SQL for the new signals in the stream 8 migration; web tests for the signal wording and the disabled state. |
| Non-goals | Cron route, service identity code, per-organization database bytes, billing from quotas. |

### Stream 8: Reliability and recovery proof (#44)

| Field | Content |
|---|---|
| Current behavior | `/settings/health`, `health_summary`, append-only `recovery_drills` written by the platform owner with free-text evidence; no provider backup status. |
| HomePaw behavior | None comparable. |
| Proposed scope | Verifiable evidence for a drill: `record_recovery_drill_with_evidence` additionally takes the **archive manifest SHA-256** and the **restore report SHA-256** printed by the stream 4 tool. The database sets `evidence_matches_export` to true only when a completed `organization_export_jobs` row with that manifest hash exists (it cannot confirm that the restore happened; the drill stays a human-attested fact and says so). Health shows "drills with matching evidence". Cleanup signals from stream 7. The restore-drill runbook and evidence template updated to the importer. |
| Risks | A matched hash proves an archive existed, not that it was restored. The wording states this. |
| Owner decisions | D8: who performs and signs a drill; target cadence (for example quarterly); the staging or disposable project to use. |
| Migration | `20261101160000_recovery_evidence.sql`. |
| Authorization | Platform owner records drills; business owners see only their own summary signals; platform-versus-tenant redaction unchanged. |
| Tests | SQL: hash match and mismatch, malformed hash refused, append-only, non-platform refused, credential-like text refused, redaction. Web: owner actions, wording. |
| Non-goals | Reading Supabase backup or point-in-time status, simulating a restore, marking a drill passed automatically. |

## Migration plan

All forward-only, after `20261031160000_health_signals.sql`:

1. `20261101100000_marketing_spend_roi.sql`
2. `20261101110000_cash_account_mappings.sql`
3. `20261101120000_whatsapp_provider_boundary.sql`
4. `20261101140000_business_defaults.sql`
5. `20261101150000_access_readiness.sql`
6. `20261101160000_recovery_evidence.sql`

(Stream 4 and stream 7 add no migration.) Each redefines `app.schema_version()`; the final value equals the newest file and `EXPECTED_SCHEMA_VERSION` follows. `run_all_gates.sh`, the populated-upgrade rehearsal and its probe are extended in the same commits.

## Verification plan

Per stream: focused web tests (empty, error, denied), SQL role tests on PostgreSQL 16 with real `authenticated`/`anon`, populated-upgrade probe on the HomePaw demo data. Overall: full web suite, root and web typecheck, lint with zero warnings, production build, `git diff --check`, local browser pass (owner and restricted role) on a local Supabase stack. No hosted staging, real Storage, WhatsApp or mail test will occur; the handoff will say so.
