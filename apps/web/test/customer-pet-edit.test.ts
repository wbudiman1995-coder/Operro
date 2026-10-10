import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PET_BREED_MAX,
  PET_COLOR_MAX,
  PET_NAME_MAX,
  PET_NOTES_MAX,
  PET_SKIN_HISTORY_MAX,
  PET_TEMPERAMENT_MAX,
  parseCustomerPetForm,
} from "../src/lib/customer-pet-edit";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const actions = read("apps/web/src/app/customers/[customerId]/actions.ts");
const actionSource = actions.slice(actions.indexOf("export async function editCustomerPetAction"));
const editorSource = read("apps/web/src/components/customer-pet-editor.tsx");
const pageSource = read("apps/web/src/app/customers/[customerId]/page.tsx");
const migration = read("supabase/migrations/20261026100000_customer_pet_edit.sql");
const coatMigration = read("supabase/migrations/20261029110000_pet_coat_profile.sql");
const gates = read("run_all_gates.sh");

function form(overrides: Record<string, string | Blob | string[]> = {}): FormData {
  const values: Record<string, string | Blob | string[]> = {
    name: " Moka ", species: "dog", breed: " Poodle ", sex: "female", birthdate: "2022-05-03",
    weightKg: "7.25", manualSize: "small", color: " Apricot ", temperament: "Tenang", notes: "Suka snack", coatType: "curly", skinHistory: " 12 Mei: kutu ", ...overrides,
  };
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) for (const item of value) result.append(key, item);
    else result.append(key, value);
  }
  return result;
}

test("parses editable pet facts without derived or tenant fields", () => {
  const parsed = parseCustomerPetForm(form());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.update, {
    name: "Moka", species: "dog", breed: "Poodle", sex: "female", birthdate: "2022-05-03",
    weightKg: 7.25, manualSize: "small", color: "Apricot", temperament: "Tenang", notes: "Suka snack",
    coatType: "curly", skinHistory: "12 Mei: kutu",
  });
  assert.deepEqual(Object.keys(parsed.update).sort(), ["birthdate", "breed", "coatType", "color", "manualSize", "name", "notes", "sex", "skinHistory", "species", "temperament", "weightKg"]);
});

test("normalizes blank optional values and permits a weightless dog band", () => {
  const parsed = parseCustomerPetForm(form({ breed: " ", birthdate: "", weightKg: "", manualSize: "xxl", color: "", temperament: "", notes: "" }));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.update, { name: "Moka", species: "dog", breed: null, sex: "female", birthdate: null, weightKg: null, manualSize: "xxl", color: null, temperament: null, notes: null, coatType: "curly", skinHistory: "12 Mei: kutu" });
});

test("coat type and skin history: blank clears, unknown coat or overlong history is rejected, no stored counter is accepted", () => {
  const cleared = parseCustomerPetForm(form({ coatType: "", skinHistory: "  " }));
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.deepEqual([cleared.update.coatType, cleared.update.skinHistory], [null, null]);
  for (const coat of ["short", "long", "curly", "double_coat"]) assert.equal(parseCustomerPetForm(form({ coatType: coat })).ok, true, coat);
  assert.equal(parseCustomerPetForm(form({ coatType: "wavy" })).ok, false);
  assert.equal(parseCustomerPetForm(form({ coatType: "Short" })).ok, false);
  assert.equal(parseCustomerPetForm(form({ skinHistory: "s".repeat(PET_SKIN_HISTORY_MAX + 1) })).ok, false);
  const withCounter = form();
  withCounter.append("washCount", "99");
  const parsed = parseCustomerPetForm(withCounter);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal("washCount" in parsed.update, false, "a submitted counter is ignored, never stored");
  assert.match(coatMigration, /pet_visit_stats/);
  assert.doesNotMatch(coatMigration, /add column[^;]*(wash|visit)[a-z_]*count/i);
});

test("visit stats are derived from completed work only and the editor/page surface them read-only", () => {
  assert.match(coatMigration, /b\.status = 'completed' and b\.deleted_at is null/);
  assert.match(coatMigration, /g\.deleted_at is null and g\.status <> 'skipped'/);
  assert.match(coatMigration, /security definer\s+set search_path = ''/);
  assert.doesNotMatch(editorSource, /name="(?:completedJobs|washCount|visitCount)"/);
  assert.match(pageSource, /Kunjungan selesai/);
  assert.match(actionSource, /p_coat_type: parsed\.update\.coatType/);
});

test("rejects malformed species, size, weight, date, duplicates, and non-dog manual size", () => {
  const invalids: Array<Record<string, string>> = [
    { species: "Dog" }, { manualSize: "not valid" }, { weightKg: "0" }, { weightKg: "1000" },
    { weightKg: "1.234" }, { birthdate: "2025-02-30" }, { species: "cat", manualSize: "small" },
  ];
  for (const overrides of invalids) assert.equal(parseCustomerPetForm(form(overrides)).ok, false);
  assert.equal(parseCustomerPetForm(form({ name: ["Moka", "Milo"] })).ok, false);
  assert.equal(parseCustomerPetForm(form({ notes: new Blob(["x"]) })).ok, false);
});

test("enforces all edit field length limits", () => {
  assert.equal(parseCustomerPetForm(form({ name: "n".repeat(PET_NAME_MAX + 1) })).ok, false);
  assert.equal(parseCustomerPetForm(form({ breed: "b".repeat(PET_BREED_MAX + 1) })).ok, false);
  assert.equal(parseCustomerPetForm(form({ color: "c".repeat(PET_COLOR_MAX + 1) })).ok, false);
  assert.equal(parseCustomerPetForm(form({ temperament: "t".repeat(PET_TEMPERAMENT_MAX + 1) })).ok, false);
  assert.equal(parseCustomerPetForm(form({ notes: "n".repeat(PET_NOTES_MAX + 1) })).ok, false);
});

test("server action authorizes, validates, and calls only the tenant-derived RPC", () => {
  assert.match(actionSource, /requireActiveWorkspace/);
  assert.match(actionSource, /workspace\.capabilities\["customer\.manage"\]/);
  assert.ok(actionSource.indexOf("parseCustomerPetForm") < actionSource.indexOf('rpc("update_customer_pet"'));
  assert.match(actionSource, /schema\("app"\)\.rpc\("update_customer_pet"/);
  assert.doesNotMatch(actionSource, /organizationId|p_org|price|size_label|layout_version/);
  assert.match(actionSource, /p_pet: petId/);
  assert.match(actionSource, /p_customer: customerId/);
  assert.match(actionSource, /p_expected_updated_at: expected\.value/);
  assert.doesNotMatch(actionSource, /error\.details|error\.hint/);
});

test("RPC is authenticated, active-tenant scoped, permission gated, and delegates sizing to the existing pet trigger", () => {
  assert.match(migration, /v_org uuid := app\.fn_active_organization\(\)/);
  assert.match(migration, /app\.has_membership\(\)[\s\S]*app\.has_module\('crm'\)[\s\S]*app\.has_permission\('customer\.manage'\)/);
  assert.match(migration, /p\.organization_id = v_org[\s\S]*p\.customer_id = p_customer/);
  assert.match(migration, /organization_pet_types[\s\S]*t\.is_active/);
  assert.match(migration, /organization_size_bands[\s\S]*band_kind = 'dog_weight'[\s\S]*status = 'active'/);
  assert.match(migration, /perform app\.size_layout_lock\(v_org\)/);
  assert.match(migration, /set[\s\S]*weight_kg = p_weight_kg,[\s\S]*size = v_size/);
  assert.doesNotMatch(migration, /update public\.(grooming_job_pet_services|customer_packages|payroll_items)/);
  assert.match(migration, /revoke all on function app\.update_customer_pet[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function app\.update_customer_pet[\s\S]*to authenticated/);
});

test("Customer 360 exposes active tenant choices and never submits derived pricing data", () => {
  assert.match(pageSource, /organization_pet_types/);
  assert.match(pageSource, /organization_size_bands/);
  assert.match(pageSource, /<CustomerPetEditor/);
  assert.match(pageSource, /capabilities\["customer\.manage"\]/);
  assert.match(editorSource, /name="petId"/);
  assert.match(editorSource, /name="expectedUpdatedAt"/);
  assert.match(editorSource, /name="weightKg"/);
  assert.match(editorSource, /name="manualSize"/);
  assert.doesNotMatch(editorSource, /name="(?:organizationId|price|sizeLabel|layoutVersion)"/);
  assert.match(editorSource, /server menghitung ulang dari berat/);
});

test("full gate invokes focused web and SQL coverage", () => {
  assert.match(gates, /customer-pet-edit\.test\.ts/);
  assert.match(gates, /customer_pet_edit_smoke\.sql/);
});
