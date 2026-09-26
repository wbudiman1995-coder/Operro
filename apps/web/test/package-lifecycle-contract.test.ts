import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260925100000_package_membership_lifecycle.sql"), "utf8");
// renew_customer_package and reconcile_customer_package are SUPERSEDED here (drop+create /
// create-or-replace in the follow-up migration below) -- the base migration's definitions of
// those two functions no longer reflect what actually runs. Everything else in `migration`
// (coverage RPC, per-pet reserve check, packages/customer_packages columns, set_customer_package_status)
// is still current.
const followup = fs.readFileSync(path.join(root, "supabase/migrations/20260926090000_membership_renewal_billing_and_reconciliation.sql"), "utf8");
const actions = fs.readFileSync(path.join(root, "apps/web/src/app/pilot-actions.ts"), "utf8");
const pilotForms = fs.readFileSync(path.join(root, "apps/web/src/components/pilot-forms.tsx"), "utf8");
const pilotData = fs.readFileSync(path.join(root, "apps/web/src/lib/pilot-data.ts"), "utf8");
const packageManager = fs.readFileSync(path.join(root, "apps/web/src/components/package-manager.tsx"), "utf8");
const bookingsLib = fs.readFileSync(path.join(root, "apps/web/src/lib/bookings.ts"), "utf8");
const bookingWizard = fs.readFileSync(path.join(root, "apps/web/src/components/booking-wizard.tsx"), "utf8");
const membershipAdmin = fs.readFileSync(path.join(root, "apps/web/src/lib/membership-admin.ts"), "utf8");
const membershipManager = fs.readFileSync(path.join(root, "apps/web/src/components/membership-manager.tsx"), "utf8");
const gates = fs.readFileSync(path.join(root, "run_all_gates.sh"), "utf8");
const capabilities = fs.readFileSync(path.join(root, "apps/web/src/lib/authorization.ts"), "utf8");

const reserveFn = migration.slice(migration.indexOf("function app.reserve_package_session"), migration.indexOf("function app.create_package_invoice"));
const statusFn = migration.slice(migration.indexOf("function app.set_customer_package_status"), migration.indexOf("function app.reconcile_customer_package"));
const renewFn = followup.slice(followup.indexOf("create function app.renew_customer_package"), followup.indexOf("revoke all on function app.renew_customer_package"));
const previewRenewFn = followup.slice(followup.indexOf("create or replace function app.preview_package_renewal"), followup.indexOf("revoke all on function app.preview_package_renewal"));
const reconcileFn = followup.slice(followup.indexOf("create or replace function app.reconcile_customer_package"));

/**
 * A helper's presence AND its RPC call are asserted as two independent
 * `assert.match` calls (never one `[\s\S]{0,N}` distance-bound window
 * spanning both) -- a fixed character budget between two anchors breaks
 * every time unrelated code grows between them (this happened twice on
 * this branch already; see the handoff's "flaky test" correction). This is
 * intentionally a weaker check than a distance window, in exchange for not
 * being brittle busywork disconnected from the actual bug it's meant to
 * catch -- the SQL integration smoke test is what actually proves behavior.
 */
function assertFunctionCallsRpc(source: string, functionName: string, rpcName: string) {
  const start = source.indexOf(`function ${functionName}`);
  assert.ok(start >= 0, `expected to find function ${functionName}`);
  const nextFunction = source.indexOf("\nexport async function", start + 1);
  const body = nextFunction > start ? source.slice(start, nextFunction) : source.slice(start);
  assert.match(body, new RegExp(`rpc\\("${rpcName}"`), `expected ${functionName} to call rpc("${rpcName}")`);
}

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

test("section 23: the booking-wizard over-allocation warning counts every OTHER (pet, service) cell against the same package, including a different service on the SAME pet", () => {
  // Regression test for a real bug: the original warning excluded the whole
  // current pet from the count, so pet A's service-2 allocation never saw
  // pet A's own service-1 allocation of the same package.
  assert.match(bookingWizard, /Object\.entries\(other\.packageByService\)\.filter\(\(\[otherServiceId, id\]\) => id === selectedPackageId && !\(other\.petId === selection\.petId && otherServiceId === service\.id\)\)/);
});

test("section 24: packages gain a truthful recurrence interval and a per-pet flag, no invented auto-billing/scheduler", () => {
  assert.match(migration, /add column recurrence_interval text not null default 'none'/);
  assert.match(migration, /chk_packages_recurrence_interval check \(recurrence_interval in \('none','week','month','year'\)\)/);
  assert.match(migration, /add column per_pet boolean not null default false/);
  assert.doesNotMatch(migration, /pg_cron|cron\.schedule|stripe|charge_card/i);
  assert.doesNotMatch(followup, /pg_cron|cron\.schedule|stripe|charge_card/i);
});

test("section 24: customer_packages gets a real source_invoice_id FK (superseding the metadata convention) and per-pet scope, backfilled from existing rows", () => {
  assert.match(migration, /add column source_invoice_id uuid/);
  assert.match(migration, /fk_customer_packages_source_invoice foreign key \(organization_id, source_invoice_id\)/);
  assert.match(migration, /update public\.customer_packages cp\s*\n\s*set source_invoice_id = i\.id/);
  assert.match(migration, /i\.id::text = cp\.metadata->>'source_invoice_id'/);
  assert.match(migration, /add column pet_id uuid/);
});

test("section 24: create_package_invoice guards idempotency keys against different sale inputs and accepts a pet", () => {
  const invoiceFn = migration.slice(migration.indexOf("create function app.create_package_invoice"));
  assert.match(invoiceFn, /select \* into v_invoice from public\.invoices where organization_id=v_org and request_key=p_request_key;/);
  assert.match(invoiceFn, /request_key_reused_for_different_invoice/);
  assert.match(migration, /create function app\.create_package_invoice\(\s*\n\s*p_branch uuid, p_customer uuid, p_package uuid, p_issued_at timestamptz, p_due_at timestamptz,\s*\n\s*p_admin_notes text, p_request_key uuid, p_pet uuid default null\)/);
});

test("section 24 follow-up: every purchase/renewal ledger row can carry an invoice_id, stamped by create_package_invoice/renew_customer_package at INSERT time, and NEVER backfilled onto pre-existing rows (an UPDATE against the append-only customer_package_ledger would raise restrict_violation the moment a real purchase already existed -- fixed by review finding #1)", () => {
  assert.match(followup, /alter table public\.customer_package_ledger\s*\n\s*add column invoice_id uuid;/);
  assert.match(followup, /add constraint fk_cpl_invoice foreign key \(organization_id, invoice_id\)/);
  const invoiceFn = followup.slice(followup.indexOf("create or replace function app.create_package_invoice"));
  assert.match(invoiceFn, /insert into public\.customer_package_ledger\(organization_id,customer_package_id,delta,reason,notes,invoice_id\)/);
  // The regression itself: no UPDATE statement against customer_package_ledger
  // anywhere in this migration (only INSERTs, which are never blocked).
  assert.doesNotMatch(followup, /update public\.customer_package_ledger/);
});

test("section 24 follow-up: a paid renewal is a real commercial transaction -- it creates an order/invoice/invoice_lines, not just a session top-up, and requires an explicit branch (never a silently guessed one)", () => {
  assert.match(followup, /drop function if exists app\.renew_customer_package\(uuid, uuid\);/);
  assert.match(followup, /create function app\.renew_customer_package\(\s*\n\s*p_customer_package uuid, p_branch uuid, p_issued_at timestamptz, p_due_at timestamptz,\s*\n\s*p_admin_notes text, p_request_key uuid\)\s*\nreturns public\.invoices/);
  assert.match(renewFn, /insert into public\.orders\(organization_id, branch_id, customer_id, status, currency, metadata\)/);
  assert.match(renewFn, /insert into public\.invoices\(organization_id, branch_id, customer_id, order_id, invoice_number, status, currency,/);
  assert.match(renewFn, /insert into public\.customer_package_ledger \(organization_id, customer_package_id, delta, reason, notes, request_key, invoice_id\)\s*\n\s*values \(v_org, cp\.id, pkg\.total_sessions, 'renewal'/);
  assert.doesNotMatch(renewFn, /p_branch uuid default/); // no default -- branch is mandatory, never optional/guessed
});

test("section 24 follow-up: renewal reuses the SAME status is 'canceled' / catalog inactive guards, extends expiry from greatest(now, current expiry), and reactivates an exhausted/expired package uniformly (no per-status special case)", () => {
  assert.match(renewFn, /if cp\.status = 'canceled' then raise exception 'package_canceled_cannot_renew'/);
  assert.match(renewFn, /if not pkg\.is_active then raise exception 'package_catalog_inactive'/);
  assert.match(renewFn, /v_new_expiry := greatest\(now\(\), coalesce\(cp\.expires_at, now\(\)\)\) \+ v_interval;/);
  assert.match(renewFn, /set status = 'active', expires_at = v_new_expiry, renewed_at = now\(\), renewal_count = renewal_count \+ 1/);
});

test("section 24 follow-up: renewal idempotency is order lock -> authorize -> idempotent-return -> validate (matches the reviewed pattern already on this branch), and rejects a request_key reused for a different membership/branch", () => {
  const lockIndex = renewFn.indexOf("for update;");
  const authIndex = renewFn.indexOf("not app.has_branch(p_branch)");
  const idempotentReturnIndex = renewFn.indexOf("select * into v_invoice from public.invoices where organization_id = v_org and request_key = p_request_key;");
  const validateIndex = renewFn.indexOf("if cp.status = 'canceled'");
  assert.ok(lockIndex >= 0 && authIndex > lockIndex && idempotentReturnIndex > authIndex && validateIndex > idempotentReturnIndex, "expected lock -> authorize -> idempotent-return -> validate ordering");
  assert.match(renewFn, /v_invoice\.branch_id <> p_branch\s*\n\s*or v_invoice\.metadata->>'renewal_of' is distinct from cp\.id::text/);
  assert.match(renewFn, /request_key_reused_for_different_renewal/);
});

test("section 24 follow-up: the renewal idempotency check does NOT compare catalog price -- price is server-derived state, not a caller input, so a legitimate retry after a catalog price change must still return the original invoice (review finding #3)", () => {
  assert.doesNotMatch(renewFn, /v_invoice\.total <> pkg\.price/);
});

test("section 24 follow-up: rollover_policy actually governs renewal (it was previously read but never consumed -- review finding #2). 'none' discards only the UNRESERVED excess via a compensating adjustment row, never a raw UPDATE, and never touches reserved/held sessions", () => {
  assert.match(renewFn, /if pkg\.rollover_policy = 'none' then/);
  assert.match(renewFn, /select count\(\*\) into v_reserved_count from public\.package_reservations/);
  assert.match(renewFn, /v_unreserved_excess := greatest\(0, cp\.sessions_remaining - v_reserved_count\);/);
  assert.match(renewFn, /insert into public\.customer_package_ledger \(organization_id, customer_package_id, delta, reason, notes\)\s*\n\s*values \(v_org, cp\.id, -v_unreserved_excess, 'adjustment'/);
  assert.doesNotMatch(renewFn, /update public\.customer_packages\s*\n\s*set sessions_remaining/); // never a raw cache overwrite
});

test("section 24 follow-up: a catalog per_pet change that disagrees with an existing membership's actual pet scope blocks renewal (never silently tops up an incompatible entitlement -- review finding #3), and app.preview_package_renewal surfaces the same check read-only before the write is attempted", () => {
  assert.match(renewFn, /if pkg\.per_pet <> \(cp\.pet_id is not null\) then\s*\n\s*raise exception 'catalog_terms_changed_incompatible_with_existing_entitlement'/);
  assert.match(previewRenewFn, /v_incompatible := cp\.status <> 'canceled' and pkg\.per_pet <> \(cp\.pet_id is not null\);/);
  assert.match(previewRenewFn, /language plpgsql stable/); // read-only, no writes
  assert.doesNotMatch(previewRenewFn, /insert into|update public\.|delete from/);
});

test("section 24 follow-up: a renewal preview action exists in the UI and the renew form's submit is disabled when the preview reports a blocking reason", () => {
  assert.match(actions, /export async function previewPackageRenewalAction/);
  assert.match(actions, /rpc\("preview_package_renewal"/);
  assert.match(membershipManager, /disabled=\{renewPending \|\| Boolean\(renewalPreview\?\.blockingReason\)\}/);
});

test("section 25: archiving (set_customer_package_status) is guarded and refuses to cancel a package with an outstanding reserved session", () => {
  assert.match(statusFn, /if v_active_reservations > 0 then\s*\n\s*raise exception 'package_has_active_reservations'/);
});

test("section 25: the membership administration page filters by status/urgency, flags legacy (no source invoice) rows, and links back to Customer 360", () => {
  assert.match(membershipAdmin, /export type MembershipUrgency/);
  assert.match(membershipAdmin, /function urgencyOf/);
  assert.match(membershipAdmin, /isLegacy: !row\.source_invoice_id/);
  assert.match(membershipManager, /href=\{`\/customers\/\$\{row\.customerId\}`\}/);
});

test("section 25: the renewal form in the UI requires an explicit branch (defaulted to the source invoice's branch when known, never silently substituted) and issues an invoice", () => {
  assert.match(membershipManager, /name="branchId" defaultValue=\{row\.sourceInvoiceBranchId \?\? ""\}/);
  assert.match(actions, /const result = await context\.supabase\.schema\("app"\)\.rpc\("renew_customer_package", \{\s*\n\s*p_customer_package: customerPackageId, p_branch: branchId, p_issued_at: issuedAt, p_due_at: dueAt,/);
});

test("section 25: membership history (purchases/renewals/consumption/reservations) loads scoped to one membership, never an unbounded organization-wide scan", () => {
  assert.match(actions, /export async function loadMembershipHistoryAction\(customerPackageId: string\)/);
  assert.match(actions, /eq\("customer_package_id", customerPackageId\)/);
  assert.match(membershipManager, /loadMembershipHistoryAction/);
});

test("section 24: package catalog terms (recurrence/per-pet/sessions/price/validity/active) are configurable in the UI, reusing the RLS-guarded table-write pattern already used by createServiceAction (no bespoke RPC, no second package system)", () => {
  assert.match(actions, /export async function createPackageAction/);
  assert.match(actions, /export async function updatePackageAction/);
  assert.match(actions, /createPackageAction[\s\S]*?loadCapabilities\(context\.supabase\)\)\["membership\.manage"\]/);
  assert.match(actions, /updatePackageAction[\s\S]*?loadCapabilities\(context\.supabase\)\)\["membership\.manage"\]/);
  assert.match(actions, /context\.supabase\.from\("packages"\)\.insert/);
  assert.match(actions, /context\.supabase\.from\("packages"\)\.update/);
  assert.match(pilotForms, /export function PackageForm/);
  assert.match(packageManager, /export function PackageManager/);
  assert.match(pilotData, /recurrenceInterval: row\.recurrence_interval, perPet: row\.per_pet/);
});

test("section 24: editing the catalog can never rewrite an already-sold membership -- updatePackageAction only ever writes public.packages, never public.customer_packages", () => {
  const start = actions.indexOf("export async function updatePackageAction");
  const end = actions.indexOf("\nexport async function", start + 1);
  const body = actions.slice(start, end > start ? end : undefined);
  assert.doesNotMatch(body, /customer_packages/);
});

test("section 25/26: renew, archive, catalog writes, and repair are all gated behind membership.manage; reconcile preview only needs membership.read", () => {
  assertFunctionCallsRpc(actions, "renewCustomerPackageAction", "renew_customer_package");
  assertFunctionCallsRpc(actions, "setCustomerPackageStatusAction", "set_customer_package_status");
  assertFunctionCallsRpc(actions, "repairCustomerPackageBalanceAction", "repair_customer_package_balance");
  assert.match(actions, /renewCustomerPackageAction[\s\S]*?loadCapabilities\(context\.supabase\)\)\["invoice\.issue"\]/);
  assert.match(reconcileFn, /perform app\.assert_tenant_authorized\(v_org, 'membership', 'membership\.read'\)/);
  const repairFn = migration.slice(migration.indexOf("function app.repair_customer_package_balance"));
  assert.match(repairFn, /perform app\.assert_tenant_authorized\(v_org, 'membership', 'membership\.manage'\)/);
});

test("section 26: reconciliation never writes (it is language ... stable, no insert/update/delete in its body), and separates auto-repairable cache drift from manual-review-only issues", () => {
  assert.match(followup, /function app\.reconcile_customer_package\(p_customer_package uuid\)\s*\nreturns jsonb\s*\nsecurity definer set search_path = app, public\s*\nlanguage plpgsql stable as \$\$/);
  assert.doesNotMatch(reconcileFn, /insert into|update public\.|delete from/);
  assert.match(reconcileFn, /'auto_repairable', cp\.sessions_remaining <> v_ledger_balance/);
  assert.match(reconcileFn, /'manual_review_issues', v_manual_review/);
});

test("section 26: reconciliation verifies actual reservation<->ledger LINKS (consumption_ledger_id / reversal_ledger_id), not just matching counts, and flags orphan consumption ledger rows and unlinked renewal invoices (review finding #4)", () => {
  assert.match(reconcileFn, /pr\.consumption_ledger_id[\s\S]*cpl\.reason = 'consumption' and cpl\.delta = -1/);
  assert.match(reconcileFn, /pr\.reversal_ledger_id[\s\S]*cpl\.reason = 'adjustment' and cpl\.delta = 1/);
  assert.match(reconcileFn, /v_orphan_consumption_ledger/);
  assert.match(reconcileFn, /cpl\.reason = 'renewal' and cpl\.invoice_id is null/);
  assert.match(reconcileFn, /v_over_reserved := v_reserved > cp\.sessions_remaining/);
  assert.match(reconcileFn, /v_expired_status_mismatch := cp\.status = 'active' and cp\.expires_at is not null and cp\.expires_at < now\(\)/);
});

test("section 26: a non-null invoice_id is not treated as proof of correct provenance by itself -- the linked invoice must actually belong to the same customer/package, be non-void, and have a matching invoice line (review finding #4, replacing the prior 'is invoice_id non-null' check)", () => {
  assert.match(reconcileFn, /and i\.customer_id = cp\.customer_id and i\.status in \('issued', 'paid'\)/);
  assert.match(reconcileFn, /il\.item_type = 'package' and il\.package_id = cp\.package_id/);
  assert.match(reconcileFn, /v_invalid_invoice_links/);
});

test("section 26: a reservation released after being consumed (without a reversal_ledger_id) and duplicate consumption links (two reservations sharing one consumption_ledger_id) are both detected, not assumed impossible (review finding #4)", () => {
  assert.match(reconcileFn, /pr\.consumption_ledger_id is not null and pr\.status <> 'consumed' and pr\.reversal_ledger_id is null/);
  assert.match(reconcileFn, /v_missing_reversal_link/);
  assert.match(reconcileFn, /pr2\.consumption_ledger_id = pr1\.consumption_ledger_id/);
  assert.match(reconcileFn, /v_duplicate_consumption_links/);
});

test("section 26: repair re-checks the caller-supplied revision against the CURRENT row and rejects a stale one with 40001, before touching any data (repair itself is untouched by the follow-up migration -- it only ever resyncs the cache, never invents financial history)", () => {
  const repairFn = migration.slice(migration.indexOf("function app.repair_customer_package_balance"));
  assert.match(repairFn, /if cp\.revision <> p_revision then\s*\n\s*raise exception 'stale_repair_request' using errcode = '40001';/);
  assert.match(repairFn, /update public\.customer_packages set sessions_remaining = v_ledger_balance, revision = revision \+ 1 where id = cp\.id;/);
  assert.doesNotMatch(followup, /function app\.repair_customer_package_balance/);
});

test("organization isolation: every new/changed RPC re-derives its own organization_id (app.fn_active_organization()) and never accepts a caller-supplied org", () => {
  for (const fn of [reserveFn, reconcileFn, renewFn, previewRenewFn, statusFn]) {
    assert.match(fn, /app\.fn_active_organization\(\)/);
  }
  assert.doesNotMatch(migration, /p_organization_id|p_org_id\b/);
  assert.doesNotMatch(followup, /p_organization_id|p_org_id\b/);
});

test("guarded purchased-term editing (a raw field-by-field editor for an already-sold membership) remains intentionally NOT implemented -- this is documented as an incomplete item in the handoff, not disguised as done", () => {
  const handoff = fs.readFileSync(path.join(root, "docs/handoffs/S23-S26-HANDOFF.md"), "utf8");
  assert.match(handoff, /purchased-term editing/i);
  assert.match(handoff, /incomplete/i);
});

test("run_all_gates.sh records both migrations' lineage", () => {
  assert.match(gates, /supabase\/migrations\/20260925100000_package_membership_lifecycle\.sql/);
  assert.match(gates, /supabase\/migrations\/20260926090000_membership_renewal_billing_and_reconciliation\.sql/);
});

test("the superseded, ledger-bypassing sellPackageAction/PackageSaleForm dead code path is removed, not left as a second package balance system", () => {
  assert.doesNotMatch(actions, /export async function sellPackageAction/);
  assert.doesNotMatch(pilotForms, /PackageSaleForm/);
});

test("membership.manage and membership.read remain the only capability keys governing this module (catalog writes reuse membership.manage, not a new key)", () => {
  assert.match(capabilities, /"membership\.read"/);
  assert.match(capabilities, /"membership\.manage"/);
});
