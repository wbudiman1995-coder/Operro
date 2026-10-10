import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  displayCustomFieldValue,
  customFieldFormValue,
  parseCustomFieldDefinitionForm,
  parseCustomFieldValuesForm,
  validateCustomFieldInput,
  type CustomFieldDefinition,
  type CustomFieldValue,
} from "../src/lib/custom-fields";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const D = (id: string, fieldType: CustomFieldDefinition["fieldType"], extra: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition => ({
  id, entityType: "customer", label: `Field ${fieldType}`, fieldType, options: [], sortOrder: 0, status: "active", updatedAt: "2026-10-09T00:00:00Z", ...extra,
});
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const defs = [
  D(ID(1), "text"), D(ID(2), "number"), D(ID(3), "date"), D(ID(4), "boolean"),
  D(ID(5), "select", { options: [{ key: "o1", label: "Teman" }, { key: "o2", label: "Iklan" }] }),
  D(ID(6), "text", { status: "archived", label: "Lama" }),
];
const form = (entries: Array<[string, string]>) => { const data = new FormData(); for (const [k, v] of entries) data.append(k, v); return data; };

test("accepts a valid value for each of the five types and clears on blank", () => {
  const parsed = parseCustomFieldValuesForm(form([
    [`cf_${ID(1)}`, " ig_owner "], [`cf_${ID(2)}`, "-3.25"], [`cf_${ID(3)}`, "2024-02-29"], [`cf_${ID(4)}`, "false"], [`cf_${ID(5)}`, "o2"],
  ]), defs);
  assert.deepEqual(parsed, { ok: true, values: { [ID(1)]: "ig_owner", [ID(2)]: "-3.25", [ID(3)]: "2024-02-29", [ID(4)]: "false", [ID(5)]: "o2" } });
  const cleared = parseCustomFieldValuesForm(form([[`cf_${ID(1)}`, "   "]]), defs);
  assert.deepEqual(cleared, { ok: true, values: { [ID(1)]: null } });
});

test("rejects formula-like and malformed values", () => {
  for (const text of ["=1+1", "+62812", "-cmd", "@SUM(A1)", "a\tb", "x".repeat(201)]) {
    assert.notEqual(validateCustomFieldInput(defs[0], text), null, `text ${JSON.stringify(text)}`);
  }
  for (const text of ["1e5", "=A1", "1,5", "1.12345", "--1", "1234567890123"]) assert.notEqual(validateCustomFieldInput(defs[1], text), null, `number ${text}`);
  for (const text of ["2023-02-29", "2024-13-01", "29-02-2024", "1800-01-01", "2024-1-1"]) assert.notEqual(validateCustomFieldInput(defs[2], text), null, `date ${text}`);
  for (const text of ["yes", "TRUE", "1"]) assert.notEqual(validateCustomFieldInput(defs[3], text), null, `boolean ${text}`);
  for (const text of ["o9", "Teman", "O1"]) assert.notEqual(validateCustomFieldInput(defs[4], text), null, `select ${text}`);
});

test("refuses unknown, archived, repeated and cross-scope keys", () => {
  assert.equal(parseCustomFieldValuesForm(form([[`cf_${ID(99)}`, "x"]]), defs).ok, false);
  assert.equal(parseCustomFieldValuesForm(form([[`cf_${ID(6)}`, "x"]]), defs).ok, false);
  assert.equal(parseCustomFieldValuesForm(form([[`cf_${ID(1)}`, "a"], [`cf_${ID(1)}`, "b"]]), defs).ok, false);
  assert.equal(parseCustomFieldValuesForm(form([["entityId", ID(1)], ["organization_id", ID(2)]]), defs).ok, true, "non cf_ keys are ignored, never trusted");
  assert.deepEqual((parseCustomFieldValuesForm(form([["organization_id", ID(2)]]), defs) as { values: object }).values, {});
});

test("displays stored values, hides empty ones and flags removed options", () => {
  const value = (extra: Partial<CustomFieldValue>): CustomFieldValue => ({ definitionId: ID(5), customerId: ID(7), petId: null, text: null, number: null, date: null, boolean: null, option: null, ...extra });
  assert.equal(displayCustomFieldValue(defs[4], value({ option: "o2" })), "Iklan");
  assert.equal(displayCustomFieldValue(defs[4], value({ option: "o9" })), "Pilihan lama (tidak lagi tersedia)");
  assert.equal(displayCustomFieldValue(defs[4], undefined), null, "old record without a value");
  assert.equal(displayCustomFieldValue(defs[3], value({ boolean: false })), "Tidak");
  assert.equal(displayCustomFieldValue(defs[1], value({ number: 12.5 })), "12.5");
  assert.equal(customFieldFormValue(defs[3], value({ boolean: true })), "true");
  assert.equal(customFieldFormValue(defs[2], undefined), "");
});

test("definition form: creation needs scope+type, edits cannot carry them, select options are bounded", () => {
  const ok = parseCustomFieldDefinitionForm(form([["entityType", "pet"], ["fieldType", "select"], ["label", " Alergi "], ["options", "Tidak ada\nMakanan\n"], ["sortOrder", "10"]]));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.input, { id: null, entityType: "pet", label: "Alergi", fieldType: "select", optionLabels: ["Tidak ada", "Makanan"], sortOrder: 10, expectedUpdatedAt: null });
  const edit = parseCustomFieldDefinitionForm(form([["id", ID(5)], ["entityType", "pet"], ["fieldType", "select"], ["label", "Kanal"], ["options", "A\nB"], ["sortOrder", "0"], ["expectedUpdatedAt", "2026-10-09T00:00:00Z"]]));
  assert.equal(edit.ok, true);
  if (edit.ok) assert.deepEqual([edit.input.entityType, edit.input.fieldType], [null, null], "type and scope never travel on an edit");
  const bad: Array<Array<[string, string]>> = [
    [["entityType", "vehicle"], ["fieldType", "text"], ["label", "x"]],
    [["entityType", "pet"], ["fieldType", "formula"], ["label", "x"]],
    [["entityType", "pet"], ["fieldType", "text"], ["label", " "]],
    [["entityType", "pet"], ["fieldType", "text"], ["label", "x".repeat(61)]],
    [["entityType", "pet"], ["fieldType", "text"], ["label", "x"], ["options", "A"]],
    [["entityType", "pet"], ["fieldType", "select"], ["label", "x"], ["options", ""]],
    [["entityType", "pet"], ["fieldType", "select"], ["label", "x"], ["options", "A\na"]],
    [["entityType", "pet"], ["fieldType", "select"], ["label", "x"], ["options", Array.from({ length: 13 }, (_, i) => `o${i}`).join("\n")]],
    [["entityType", "pet"], ["fieldType", "text"], ["label", "x"], ["sortOrder", "10000"]],
    [["entityType", "pet"], ["fieldType", "text"], ["label", "x"], ["label", "y"]],
  ];
  for (const entries of bad) assert.equal(parseCustomFieldDefinitionForm(form(entries)).ok, false, JSON.stringify(entries));
});

test("migration, actions and page keep the server-derived tenancy and capability contract", () => {
  const migration = read("supabase/migrations/20261029100000_custom_fields.sql");
  assert.match(migration, /app\.has_permission\('settings\.manage'\)/);
  assert.match(migration, /app\.has_permission\('customer\.manage'\)/);
  assert.equal((migration.match(/security definer set search_path = ''/g) ?? []).length, 3);
  assert.match(migration, /revoke all on public\.custom_field_definitions, public\.custom_field_values from public, anon, authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update|delete)[^;]*custom_field/i);
  assert.doesNotMatch(migration, /jsonb\s+not null default '\{\}'/, "no arbitrary JSON value column");

  const valuesAction = read("apps/web/src/app/customers/[customerId]/custom-field-actions.ts");
  const defAction = read("apps/web/src/app/settings/custom-fields/actions.ts");
  for (const source of [valuesAction, defAction]) {
    assert.doesNotMatch(source, /organization_id|organizationId|p_org\b/, "the browser never supplies tenancy");
    assert.match(source, /requireActiveWorkspace\(\)/);
  }
  assert.match(valuesAction, /capabilities\["customer\.manage"\]/);
  assert.match(defAction, /capabilities\["settings\.manage"\]/);
  const page = read("apps/web/src/app/settings/custom-fields/page.tsx");
  assert.match(page, /settings\.manage/);
});
