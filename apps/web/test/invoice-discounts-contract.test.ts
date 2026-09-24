import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260924140000_invoice_discounts_charges.sql"), "utf8");
const actions = fs.readFileSync(path.join(root, "apps/web/src/app/pilot-actions.ts"), "utf8");
const panel = fs.readFileSync(path.join(root, "apps/web/src/components/invoice-discount-panel.tsx"), "utf8");
const financialSales = fs.readFileSync(path.join(root, "supabase/migrations/20260721000800_financial_sales.sql"), "utf8");
const gates = fs.readFileSync(path.join(root, "run_all_gates.sh"), "utf8");

const calculator = migration.slice(migration.indexOf("function app._compute_invoice_pricing"), migration.indexOf("function app.preview_invoice_pricing"));
const issuance = migration.slice(migration.indexOf("function app.issue_invoice_for_booking"));

test("invoice-level percentage discount is validated (0-100) and applied to whatever remains after prior layers", () => {
  assert.match(calculator, /v_invoice_type not in \('percent','fixed'\)/);
  assert.match(calculator, /v_invoice_value < 0 or \(v_invoice_type = 'percent' and v_invoice_value > 100\)/);
  assert.match(calculator, /if v_invoice_type = 'percent' then v_invoice_amt := round\(v_remaining \* v_invoice_value \/ 100, 2\);/);
});

test("invoice-level fixed discount is a single pool consumed deterministically across eligible lines", () => {
  assert.match(calculator, /if v_invoice_type = 'fixed' then v_invoice_fixed_remaining := v_invoice_value; end if;/);
  assert.match(calculator, /else v_invoice_amt := least\(v_remaining, v_invoice_fixed_remaining\); v_invoice_fixed_remaining := v_invoice_fixed_remaining - v_invoice_amt;/);
});

test("an invoice discount can be restricted to Basic Grooming lines only", () => {
  assert.match(calculator, /v_invoice_basic_only := coalesce\(\(p_invoice_discount->>'basicGroomingOnly'\)::boolean, false\)/);
  assert.match(calculator, /if v_invoice_type is not null and \(not v_invoice_basic_only or v_new_category = 'Basic Grooming'\) then/);
});

test("per-pet discounts are validated and applied before per-service/category/invoice layers, keyed by grooming_job_pet_id", () => {
  assert.match(calculator, /v_key := v_rule->>'grooming_job_pet_id'; v_type := v_rule->>'type';/);
  const petLayerIndex = calculator.indexOf("v_key := v_line.grooming_job_pet_id::text;");
  const serviceLayerIndex = calculator.indexOf("v_key := v_line.service_id::text;");
  const categoryLayerIndex = calculator.indexOf("v_new_category := coalesce(v_line.category, 'Other Fees');");
  const invoiceLayerIndex = calculator.indexOf("if v_invoice_type is not null and");
  assert.ok(petLayerIndex > 0 && petLayerIndex < serviceLayerIndex && serviceLayerIndex < categoryLayerIndex && categoryLayerIndex < invoiceLayerIndex, "expected fixed order: pet -> service -> category -> invoice");
});

test("per-service discounts are keyed by service_id, not by the grooming line id, so they apply across every pet with that service", () => {
  assert.match(calculator, /v_key := v_rule->>'service_id'; v_type := v_rule->>'type';/);
  assert.match(calculator, /v_key := v_line\.service_id::text;\s*\n\s*if v_service_percent \? v_key/);
});

test("per-category discounts are restricted to the four HomePaw categories and default unclassified services to Other Fees", () => {
  assert.match(calculator, /v_key not in \('Basic Grooming','Styling','Special Charges','Other Fees'\)/);
  assert.match(calculator, /v_new_category := coalesce\(v_line\.category, 'Other Fees'\);/);
});

test("a home-service transport fee is carried onto the invoice as its own line, untouched by any discount layer", () => {
  assert.match(migration, /transport_fee := case when b\.fulfillment_mode = 'home' and coalesce\(b\.travel_fee, 0\) > 0 then b\.travel_fee else 0 end;/);
  assert.match(migration, /'name', 'Transport fee'[\s\S]*?'discount_amount', 0/);
});

test("a discount preview shares the exact same calculator as issuance and performs no writes", () => {
  assert.match(migration, /language plpgsql stable as \$\$\s*\ndeclare v_pricing record;/);
  assert.match(migration, /select \* into v_pricing from app\._compute_invoice_pricing\(p_booking, p_invoice_discount, p_pet_discounts, p_service_discounts, p_category_discounts\);/);
  assert.doesNotMatch(migration.slice(migration.indexOf("function app.preview_invoice_pricing"), migration.indexOf("function app.issue_invoice_for_booking")), /insert into|update public\.|delete from/);
});

test("every discount input is a rule (type/value/target), never a browser-supplied total, subtotal or discount amount", () => {
  assert.doesNotMatch(migration, /p_(subtotal|total|discount_total|line_total|transport_fee)\b/);
  assert.match(issuance, /v_pricing\.subtotal, v_pricing\.discount_total, 0, v_pricing\.total/);
});

test("package-covered lines are fully zeroed and skip every new discount layer without touching any fixed pool", () => {
  assert.match(calculator, /if v_package_covered then[\s\S]{0,200}v_remaining := 0;/);
  assert.match(calculator, /'package_coverage', true/);
});

test("no line total or invoice total can go negative: every discount layer is clamped with least()/greatest()", () => {
  assert.match(calculator, /v_line_total := greatest\(0, round\(v_remaining, 2\)\);/);
  assert.match(calculator, /v_pet_amt := least\(v_remaining, \(v_pet_fixed->>v_key\)::numeric\)/);
  assert.match(calculator, /v_old_discount := least\(v_gross, v_old_discount\);/);
});

test("multiple pets and services are tracked independently via per-key maps, not a single shared running total", () => {
  assert.match(calculator, /v_pet_percent jsonb := '\{\}'::jsonb; v_pet_fixed jsonb := '\{\}'::jsonb;/);
  assert.match(calculator, /v_service_percent jsonb := '\{\}'::jsonb; v_service_fixed jsonb := '\{\}'::jsonb;/);
});

test("organization isolation: both RPCs re-derive the booking's own organization_id and re-check it, never trusting a caller-supplied org", () => {
  assert.match(calculator, /perform app\.assert_tenant_authorized\(b\.organization_id, 'finance', 'invoice\.issue', b\.branch_id\);/);
  assert.match(issuance, /perform app\.assert_tenant_authorized\(b\.organization_id, 'finance', 'invoice\.issue', b\.branch_id\);/);
  assert.doesNotMatch(migration, /p_organization_id|p_org_id/);
});

test("unauthorized callers cannot preview or issue: no direct grant to anon, and revoke precedes the authenticated grant", () => {
  for (const fn of ["app._compute_invoice_pricing(uuid, jsonb, jsonb, jsonb, jsonb)", "app.preview_invoice_pricing(uuid, jsonb, jsonb, jsonb, jsonb)", "app.issue_invoice_for_booking(uuid, jsonb, jsonb, jsonb, jsonb)"]) {
    assert.match(migration, new RegExp(`revoke all on function ${fn.replace(/[.()]/g, "\\$&")} from public, authenticated;`));
  }
  assert.doesNotMatch(migration, /grant execute on function app\._compute_invoice_pricing/);
});

test("re-issuing for the same booking is refused once an order already exists (duplicate-submit safe)", () => {
  assert.match(issuance, /if exists \(select 1 from public\.orders where organization_id = b\.organization_id and booking_id = b\.id and deleted_at is null\) then\s*\n\s*raise exception 'order_already_exists'/);
});

test("issuance is one atomic PL\\/pgSQL function, not sequential app-code inserts: order, order_items, invoice and invoice_lines are all written before returning", () => {
  assert.match(issuance, /insert into public\.orders/);
  assert.match(issuance, /insert into public\.order_items/);
  assert.match(issuance, /insert into public\.invoices/);
  assert.match(issuance, /insert into public\.invoice_lines/);
  assert.ok(issuance.indexOf("insert into public.orders") < issuance.indexOf("insert into public.invoices"));
});

test("issued and paid invoices stay immutable: this migration does not touch the pre-existing freeze/append-only triggers", () => {
  assert.match(financialSales, /trg_invoices_freeze before update on public\.invoices/);
  assert.match(financialSales, /trg_invoice_lines_block_update before update on public\.invoice_lines/);
  assert.doesNotMatch(migration, /drop trigger|alter table public\.invoices\b/);
});

test("widening order_items/invoice_lines to a 'fee' item type only adds a value, it does not touch invoices/invoice_lines columns or the immutability triggers", () => {
  assert.match(migration, /alter table public\.order_items add constraint chk_order_items_type check \(item_type in \('service','product','fee'\)\);/);
  assert.match(migration, /alter table public\.invoice_lines add constraint chk_invoice_lines_type check \(item_type in \('service','product','fee'\)\);/);
});

test("client server actions only ever pass discount RULES to the RPC, and the client-side discount panel never submits a computed total", () => {
  assert.match(actions, /rpc\("issue_invoice_for_booking", \{/);
  assert.match(actions, /rpc\("preview_invoice_pricing", \{/);
  assert.doesNotMatch(panel, /name="total"|name="subtotal"|name="discountTotal"/);
});

test("pilot-actions.ts stays a valid \"use server\" module: only async functions and types are exported, never a const object/array (Next.js build error)", () => {
  assert.doesNotMatch(actions, /^export const \w+ = \[/m);
  assert.match(actions, /import \{ INVOICE_DISCOUNT_CATEGORIES \} from "@\/lib\/invoice-discount-categories";/);
});

test("the catalog category select feeds the section-22 per-category discount vocabulary exactly", () => {
  assert.match(actions, /SERVICE_CATEGORIES = new Set\(\["Basic Grooming", "Styling", "Special Charges", "Other Fees"\]\)/);
  assert.match(actions, /import \{ INVOICE_DISCOUNT_CATEGORIES \} from "@\/lib\/invoice-discount-categories";/);
  const categories = fs.readFileSync(path.join(root, "apps/web/src/lib/invoice-discount-categories.ts"), "utf8");
  assert.doesNotMatch(categories, /"use server"/);
  assert.match(categories, /INVOICE_DISCOUNT_CATEGORIES = \[/);
});

test("run_all_gates.sh records this migration's lineage", () => {
  assert.match(gates, /supabase\/migrations\/20260924140000_invoice_discounts_charges\.sql/);
});
