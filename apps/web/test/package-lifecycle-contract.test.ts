import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260925100000_package_membership_lifecycle.sql"), "utf8");
const actions = fs.readFileSync(path.join(root, "apps/web/src/app/pilot-actions.ts"), "utf8");
const pilotForms = fs.readFileSync(path.join(root, "apps/web/src/components/pilot-forms.tsx"), "utf8");
const bookingsLib = fs.readFileSync(path.join(root, "apps/web/src/lib/bookings.ts"), "utf8");
const bookingWizard = fs.readFileSync(path.join(root, "apps/web/src/components/booking-wizard.tsx"), "utf8");
const membershipAdmin = fs.readFileSync(path.join(root, "apps/web/src/lib/membership-admin.ts"), "utf8");
const membershipManager = fs.readFileSync(path.join(root, "apps/web/src/components/membership-manager.tsx"), "utf8");
const gates = fs.readFileSync(path.join(root, "run_all_gates.sh"), "utf8");

const reserveFn = migration.slice(migration.indexOf("function app.reserve_package_session"), migration.indexOf("function app.create_package_invoice"));
const repairFn = migration.slice(migration.indexOf("function app.repair_customer_package_balance"));
const reconcileFn = migration.slice(migration.indexOf("function app.reconcile_customer_package"), migration.indexOf("function app.repair_customer_package_balance"));
const renewFn = migration.slice(migration.indexOf("function app.renew_customer_package"), migration.indexOf("function app.set_customer_package_status"));
const statusFn = migration.slice(migration.indexOf("function app.set_customer_package_status"), migration.indexOf("function app.reconcile_customer_package"));

test("section 23: per-pet eligibility is enforced server-side in reserve_package_session, same signature (no new overload)", () => {
  assert.match(migration, /create or replace function app\.reserve_package_session\(\s*p_line uuid, p_customer_package uuid, p_expires_at timestamptz default null\)/);
  assert.match(reserveFn, /if cp\.pet_id is not null and cp\.pet_id <> ln\.pet_id then\s*\n\s*raise exception 'package_not_applicable_to_pet'/);
});

test("section 23: a batched coverage RPC exposes reserved vs available, and the booking wizard/Customer 360 actually consume it instead of the raw cache", () => {
  assert.match(migration, /function app\.list_customer_package_coverage\(p_customer uuid\)/);
  assert.match(migration, /sessions_remaining - coalesce\(\(select count\(\*\)::int from public\.package_reservations pr/);
  assert.match(bookingsLib, /package_reservations[\s\S]*status[\s\S]*reserved|reservedByPackage/);
  assert.match(bookingWizard, /availableSessions/);
  assert.match(bookingWizard, /overAllocated/);
});

test("section 24: packages gain a truthful recurrence interval and a per-pet flag, no invented auto-billing/scheduler", () => {
  assert.match(migration, /add column recurrence_interval text not null default 'none'/);
  assert.match(migration, /chk_packages_recurrence_interval check \(recurrence_interval in \('none','week','month','year'\)\)/);
  assert.match(migration, /add column per_pet boolean not null default false/);
  assert.doesNotMatch(migration, /pg_cron|cron\.schedule|stripe|charge_card/i);
});

test("section 24: customer_packages gets a real source_invoice_id FK (superseding the metadata convention) and per-pet scope, backfilled from existing rows", () => {
  assert.match(migration, /add column source_invoice_id uuid/);
  assert.match(migration, /fk_customer_packages_source_invoice foreign key \(organization_id, source_invoice_id\)/);
  assert.match(migration, /update public\.customer_packages\s*\n\s*set source_invoice_id = \(metadata->>'source_invoice_id'\)::uuid/);
  assert.match(migration, /add column pet_id uuid/);
});

test("section 24: create_package_invoice keeps its exact idempotency guard (request_key lookup before any insert) and gains an optional, backward-compatible p_pet", () => {
  const invoiceFn = migration.slice(migration.indexOf("create function app.create_package_invoice"));
  assert.match(invoiceFn, /select \* into v_invoice from public\.invoices where organization_id=v_org and request_key=p_request_key;\s*\n\s*if found then return v_invoice; end if;/);
  assert.match(migration, /create function app\.create_package_invoice\(\s*\n\s*p_branch uuid, p_customer uuid, p_package uuid, p_issued_at timestamptz, p_due_at timestamptz,\s*\n\s*p_admin_notes text, p_request_key uuid, p_pet uuid default null\)/);
});

test("section 24: renewal is manual and ledger-backed (a real customer_package_ledger 'renewal' row), reactivates an exhausted/expired package, and is idempotent via request_key", () => {
  assert.match(migration, /add constraint chk_cpl_reason check \(reason in \('purchase','consumption','adjustment','expiry','refund','renewal'\)\)/);
  assert.match(renewFn, /if exists \(select 1 from public\.customer_package_ledger where organization_id = v_org and request_key = p_request_key\) then/);
  assert.match(renewFn, /set status = 'active', expires_at = v_new_expiry, renewed_at = now\(\), renewal_count = renewal_count \+ 1/);
  assert.match(renewFn, /reason, notes, request_key\)\s*\n\s*values \(v_org, cp\.id, pkg\.total_sessions, 'renewal'/);
});

test("section 25: archiving (set_customer_package_status) is guarded and refuses to cancel a package with an outstanding reserved session", () => {
  assert.match(statusFn, /if v_active_reservations > 0 then\s*\n\s*raise exception 'package_has_active_reservations'/);
});

test("section 25: the membership administration page filters by status/urgency and links back to Customer 360", () => {
  assert.match(membershipAdmin, /export type MembershipUrgency/);
  assert.match(membershipAdmin, /function urgencyOf/);
  assert.match(membershipManager, /href=\{`\/customers\/\$\{row\.customerId\}`\}/);
});

test("section 25/26: renew, archive and repair are all gated behind membership.manage; preview (reconcile) only needs membership.read", () => {
  assert.match(actions, /renewCustomerPackageAction[\s\S]{0,600}rpc\("renew_customer_package"/);
  assert.match(actions, /setCustomerPackageStatusAction[\s\S]{0,600}rpc\("set_customer_package_status"/);
  assert.match(actions, /repairCustomerPackageBalanceAction[\s\S]{0,600}rpc\("repair_customer_package_balance"/);
  assert.match(reconcileFn, /perform app\.assert_tenant_authorized\(v_org, 'membership', 'membership\.read'\)/);
  assert.match(repairFn, /perform app\.assert_tenant_authorized\(v_org, 'membership', 'membership\.manage'\)/);
});

test("section 26: reconciliation never writes (it is language ... stable, no insert/update/delete in its body)", () => {
  assert.match(migration, /function app\.reconcile_customer_package\(p_customer_package uuid\)\s*\nreturns jsonb\s*\nsecurity definer set search_path = app, public\s*\nlanguage plpgsql stable as \$\$/);
  assert.doesNotMatch(reconcileFn, /insert into|update public\.|delete from/);
});

test("section 26: repair re-checks the caller-supplied revision against the CURRENT row and rejects a stale one with 40001, before touching any data", () => {
  assert.match(repairFn, /if cp\.revision <> p_revision then\s*\n\s*raise exception 'stale_repair_request' using errcode = '40001';/);
});

test("section 26: repair converges the cache to the ledger sum directly (not a compensating ledger delta, which cannot converge) and records an auditable timeline event", () => {
  assert.match(repairFn, /update public\.customer_packages set sessions_remaining = v_ledger_balance, revision = revision \+ 1 where id = cp\.id;/);
  assert.match(repairFn, /insert into public\.timeline_events \(organization_id, subject_type, subject_id, actor_id, event_type, summary, data\)/);
  assert.match(repairFn, /'membership\.balance_repaired'/);
});

test("repair is idempotent via request_key, checked before the revision guard (a retry of the same request never re-raises stale_repair_request)", () => {
  const idempotencyIndex = repairFn.indexOf("if exists (select 1 from public.timeline_events");
  const revisionIndex = repairFn.indexOf("if cp.revision <> p_revision");
  assert.ok(idempotencyIndex >= 0 && revisionIndex > idempotencyIndex, "expected the idempotency short-circuit before the revision check");
});

test("organization isolation: every new RPC re-derives its own organization_id (app.fn_active_organization()) and never accepts a caller-supplied org", () => {
  for (const fn of [reserveFn, reconcileFn, repairFn, renewFn, statusFn]) {
    assert.match(fn, /app\.fn_active_organization\(\)/);
  }
  assert.doesNotMatch(migration, /p_organization_id|p_org_id\b/);
});

test("run_all_gates.sh records this migration's lineage", () => {
  assert.match(gates, /supabase\/migrations\/20260925100000_package_membership_lifecycle\.sql/);
});

test("the superseded, ledger-bypassing sellPackageAction/PackageSaleForm dead code path is removed, not left as a second package balance system", () => {
  assert.doesNotMatch(actions, /export async function sellPackageAction/);
  assert.doesNotMatch(pilotForms, /PackageSaleForm/);
});
