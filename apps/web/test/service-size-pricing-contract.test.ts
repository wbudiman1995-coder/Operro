import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260924130000_service_size_pricing.sql"), "utf8");
const actions = fs.readFileSync(path.join(root, "apps/web/src/app/pilot-actions.ts"), "utf8");
const pilotData = fs.readFileSync(path.join(root, "apps/web/src/lib/pilot-data.ts"), "utf8");
const serviceManager = fs.readFileSync(path.join(root, "apps/web/src/components/service-manager.tsx"), "utf8");
const financialSales = fs.readFileSync(path.join(root, "supabase/migrations/20260721000800_financial_sales.sql"), "utf8");
const gates = fs.readFileSync(path.join(root, "run_all_gates.sh"), "utf8");

test("service_catalog gains a nullable size price matrix that preserves base_price", () => {
  for (const column of ["price_small", "price_medium", "price_large", "price_extra_large"]) {
    assert.match(migration, new RegExp(`add column ${column}\\s+numeric\\(14,2\\)`));
  }
  assert.match(migration, /add column additional_duration_minutes integer not null default 0/);
  assert.doesNotMatch(migration, /alter table public\.service_catalog[\s\S]*drop column/);
  assert.doesNotMatch(migration, /alter table public\.service_catalog[\s\S]*alter column base_price/);
});

test("size and price columns are constrained non-negative / to a fixed enum", () => {
  assert.match(migration, /chk_service_catalog_price_small\s+check \(price_small is null or price_small >= 0\)/);
  assert.match(migration, /chk_pets_size check \(size is null or size in \('small','medium','large','extra_large'\)\)/);
  assert.match(migration, /chk_gjps_pet_size_snapshot check \(pet_size_snapshot is null or pet_size_snapshot in \('small','medium','large','extra_large'\)\)/);
});

test("every supported size resolves to its own catalog column in assembly_add_line", () => {
  const fn = migration.slice(migration.indexOf("function app.assembly_add_line"));
  for (const [size, column] of [["small", "sc.price_small"], ["medium", "sc.price_medium"], ["large", "sc.price_large"], ["extra_large", "sc.price_extra_large"]] as const) {
    assert.match(fn, new RegExp(`when '${size}' then ${column.replace(".", "\\.")}`));
  }
});

test("a missing size or a missing size price falls back to base_price, never null/negative", () => {
  const fn = migration.slice(migration.indexOf("function app.assembly_add_line"), migration.indexOf("function app.override_grooming_line_price"));
  assert.match(fn, /if v_pet_size is not null and v_size_price is not null then[\s\S]*v_final_price := v_size_price; v_source := 'size_matrix';/);
  assert.match(fn, /else[\s\S]*v_final_price := coalesce\(v_price, 0\); v_source := 'base';/);
});

test("additional duration only ever adds time for units beyond the first, defaulting to zero impact", () => {
  const fn = migration.slice(migration.indexOf("function app.assembly_add_line"));
  assert.match(fn, /v_final_dur := coalesce\(v_dur, 60\) \+ coalesce\(v_extra_dur, 0\) \* greatest\(p_quantity - 1, 0\)/);
});

test("the resolved size, price source and duration are snapshotted onto the line, never recomputed later", () => {
  const fn = migration.slice(migration.indexOf("function app.assembly_add_line"));
  assert.match(fn, /pet_size_snapshot, price_source\)/);
  assert.match(fn, /v_final_price, coalesce\(v_cur,'USD'\), p_quantity, v_final_dur,\s*\n\s*v_pet_size, v_source\)/);
});

test("assembly_add_line keeps its exact signature so run_all_gates.sh GATE 4's assembly-function count is unaffected", () => {
  assert.match(migration, /create or replace function app\.assembly_add_line\(p_pet uuid, p_service uuid, p_quantity integer default 1\)/);
  const assemblyFnNames = [...migration.matchAll(/create or replace function app\.(assembly_\w+)/g)].map((m) => m[1]);
  assert.deepEqual(assemblyFnNames, ["assembly_add_line"]);
});

test("manual override is a dedicated RPC outside the assembly-count gate, and requires org auth, a reason, and a non-negative price", () => {
  const fn = migration.slice(migration.indexOf("function app.override_grooming_line_price"));
  assert.doesNotMatch(fn.slice(0, 60), /assembly_/);
  assert.match(fn, /if p_price is null or p_price < 0 then[\s\S]*price_must_be_non_negative/);
  assert.match(fn, /if p_reason is null or length\(btrim\(p_reason\)\) = 0 then[\s\S]*reason_required/);
  assert.match(fn, /perform app\.assert_tenant_authorized\(b\.organization_id, 'scheduling', 'service\.manage', b\.branch_id\)/);
});

test("override is refused once an invoice already exists for the booking (issued invoice immutability boundary)", () => {
  const fn = migration.slice(migration.indexOf("function app.override_grooming_line_price"));
  assert.match(fn, /join public\.invoices i on i\.organization_id = o\.organization_id and i\.order_id = o\.id/);
  assert.match(fn, /if v_invoice_exists then[\s\S]*invoice_already_issued/);
});

test("override writes an auditable trail and revokes public/anon execute", () => {
  const fn = migration.slice(migration.indexOf("function app.override_grooming_line_price"));
  assert.match(fn, /perform app\.assembly_audit\(ln\.organization_id, ln\.grooming_job_id, 'grooming\.line_price_overridden'/);
  assert.match(migration, /revoke all on function app\.override_grooming_line_price\(uuid, numeric, text\) from public, authenticated;/);
  assert.match(migration, /grant execute on function app\.override_grooming_line_price\(uuid, numeric, text\) to authenticated;/);
});

test("financial_sales invoice/invoice_lines immutability triggers are untouched by this migration", () => {
  assert.match(financialSales, /trg_invoices_freeze before update on public\.invoices/);
  assert.match(financialSales, /trg_invoice_lines_block_update before update on public\.invoice_lines/);
  assert.doesNotMatch(migration, /alter table public\.invoices|alter table public\.invoice_lines/);
});

test("run_all_gates.sh records this migration's lineage", () => {
  assert.match(gates, /supabase\/migrations\/20260924130000_service_size_pricing\.sql/);
  assert.match(gates, /supabase\/migrations\/20260924110000_complaint_rpc_only_writes\.sql\s*\n\s*supabase\/migrations\/20260924120000_invoice_workflow\.sql\s*\n\s*supabase\/migrations\/20260924130000_service_size_pricing\.sql/);
});

test("client server actions gate service-catalog writes and the price override behind service.manage, never trusting a client-supplied booking price", () => {
  assert.match(actions, /export async function createServiceAction[\s\S]{0,300}loadCapabilities\(context\.supabase\)\)\["service\.manage"\]/);
  assert.match(actions, /export async function updateServiceAction[\s\S]{0,300}loadCapabilities\(context\.supabase\)\)\["service\.manage"\]/);
  assert.match(actions, /export async function overrideGroomingLinePriceAction[\s\S]*rpc\("override_grooming_line_price", \{ p_line: lineId, p_price: price, p_reason: reason \}\)/);
  // The booking/invoice unit price always comes from the server-resolved DB snapshot,
  // never from a client-supplied "price" field on the booking/invoice write path.
  assert.doesNotMatch(actions, /issueInvoiceForBookingAction[\s\S]*formData\.get\("price"\)/);
});

test("service create/update stay organization-scoped and validate every size price is a non-negative number or blank", () => {
  assert.match(actions, /\.from\("service_catalog"\)\.update\(\{[\s\S]*\}\)\.eq\("organization_id", context\.organizationId\)\.eq\("id", serviceId\)/);
  assert.match(actions, /function optionalPriceValue[\s\S]*Number\.isFinite\(parsed\) && parsed >= 0 \? parsed : "invalid"/);
});

test("pet size selection is optional and constrained to the four supported bands", () => {
  assert.match(actions, /const size = \["small", "medium", "large", "extra_large"\]\.includes\(sizeRaw\) \? sizeRaw : null/);
});

test("catalog admin UI exposes size prices, additional duration and fulfillment-mode checkboxes for editing", () => {
  assert.match(serviceManager, /name="price_small"|name=\{`price_\$\{suffix\}`\}/);
  assert.match(serviceManager, /name="additionalDuration"/);
  assert.match(serviceManager, /name="fulfillmentModes"/);
  assert.match(serviceManager, /name="isActive"/);
});

test("operations pricing data snapshots price_source per line so overridden lines are distinguishable", () => {
  assert.match(pilotData, /select\("id,grooming_job_pet_id,service_id,service_name_snapshot,unit_price_snapshot,price_source"\)/);
  assert.match(pilotData, /priceSource: line\.price_source/);
});

test("multiple services per pet remain supported: assembly_add_line is called once per selected service, unbounded by size logic", () => {
  const bookingActions = fs.readFileSync(path.join(root, "apps/web/src/app/bookings/actions.ts"), "utf8");
  assert.match(bookingActions, /for \(const serviceId of pet\.serviceIds\) \{[\s\S]*rpc\("assembly_add_line"/);
});
