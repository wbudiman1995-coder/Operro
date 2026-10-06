import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CUSTOMER_PROFILE_MAX_EMAIL,
  CUSTOMER_PROFILE_MAX_NAME,
  CUSTOMER_PROFILE_MAX_NOTES,
  CUSTOMER_PROFILE_MAX_PHONE,
  CUSTOMER_PROFILE_MAX_SOURCE,
  CUSTOMER_PROFILE_UPDATE_KEYS,
  isCustomerId,
  normalizeCustomerEmail,
  normalizeCustomerName,
  normalizeCustomerNotes,
  normalizeCustomerPhone,
  normalizeCustomerSource,
  parseCustomerProfileForm,
  parseExpectedUpdatedAt,
} from "../src/lib/customer-profile-edit";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const actionSource = read("apps/web/src/app/customers/[customerId]/actions.ts");
const editorSource = read("apps/web/src/components/customer-profile-editor.tsx");
const pageSource = read("apps/web/src/app/customers/[customerId]/page.tsx");
const loaderSource = read("apps/web/src/lib/customer-360.ts");
const gates = read("run_all_gates.sh");

function form(values: Record<string, string | Blob | string[]>): FormData {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) for (const entry of value) result.append(key, entry);
    else result.append(key, value);
  }
  return result;
}

const validForm = (overrides: Record<string, string | Blob | string[]> = {}) => form({
  display_name: "Budi Santoso", phone: "081234567890", email: "BUDI@Example.COM", source: "Instagram", notes: "Line one\nLine two", ...overrides,
});

test("parses exactly the five allowed fields", () => {
  const result = parseCustomerProfileForm(validForm());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.update, { display_name: "Budi Santoso", phone: "081234567890", email: "budi@example.com", source: "Instagram", notes: "Line one\nLine two" });
  assert.deepEqual(Object.keys(result.update).sort(), [...CUSTOMER_PROFILE_UPDATE_KEYS].sort());
});

test("trims fields and normalizes blank optionals", () => {
  const result = parseCustomerProfileForm(validForm({ display_name: "  Budi  ", phone: " ", email: "", source: "\t", notes: " \n " }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.update, { display_name: "Budi", phone: null, email: null, source: null, notes: null });
});

test("normalizes email and rejects obvious invalid forms", () => {
  assert.deepEqual(normalizeCustomerEmail(" USER@Example.COM "), { ok: true, value: "user@example.com" });
  for (const value of ["not-an-email", "user@", "@example.com", "user@example", "a b@example.com"]) assert.equal(normalizeCustomerEmail(value).ok, false);
});

test("enforces required name and every length boundary", () => {
  assert.equal(normalizeCustomerName(" ").ok, false);
  assert.equal(normalizeCustomerName("a".repeat(CUSTOMER_PROFILE_MAX_NAME)).ok, true);
  assert.equal(normalizeCustomerName("a".repeat(CUSTOMER_PROFILE_MAX_NAME + 1)).ok, false);
  assert.equal(normalizeCustomerPhone("1".repeat(CUSTOMER_PROFILE_MAX_PHONE)).ok, true);
  assert.equal(normalizeCustomerPhone("1".repeat(CUSTOMER_PROFILE_MAX_PHONE + 1)).ok, false);
  const domain = "@example.com";
  const local = "a".repeat(CUSTOMER_PROFILE_MAX_EMAIL - domain.length);
  assert.equal(normalizeCustomerEmail(`${local}${domain}`).ok, true);
  assert.equal(normalizeCustomerEmail(`${local}a${domain}`).ok, false);
  assert.equal(normalizeCustomerSource("s".repeat(CUSTOMER_PROFILE_MAX_SOURCE)).ok, true);
  assert.equal(normalizeCustomerSource("s".repeat(CUSTOMER_PROFILE_MAX_SOURCE + 1)).ok, false);
  assert.equal(normalizeCustomerNotes("n".repeat(CUSTOMER_PROFILE_MAX_NOTES)).ok, true);
  assert.equal(normalizeCustomerNotes("n".repeat(CUSTOMER_PROFILE_MAX_NOTES + 1)).ok, false);
});

test("rejects repeated and non-string form values", () => {
  assert.equal(parseCustomerProfileForm(form({ display_name: ["A", "B"] })).ok, false);
  assert.equal(parseCustomerProfileForm(form({ display_name: new Blob(["x"]) })).ok, false);
});

test("preserves internal note formatting", () => {
  assert.deepEqual(normalizeCustomerNotes("  First\n\nSecond  line  "), { ok: true, value: "First\n\nSecond  line" });
});

test("validates strict UUID and timestamp tokens", () => {
  assert.equal(isCustomerId("0c300000-0000-4000-8000-0000000000c1"), true);
  assert.equal(isCustomerId("0c300000-0000-0000-0000-0000000000c1"), false);
  assert.equal(isCustomerId("not-a-uuid"), false);
  assert.equal(parseExpectedUpdatedAt("2026-10-05T12:34:56.789+00:00").ok, true);
  assert.equal(parseExpectedUpdatedAt("not-a-date").ok, false);
});

test("action uses server authorization and validates before one scoped optimistic update", () => {
  const updateIndex = actionSource.indexOf('.from("customers")');
  assert.ok(updateIndex > 0);
  assert.match(actionSource, /requireActiveWorkspace/);
  assert.match(actionSource, /workspace\.capabilities\["customer\.manage"\]/);
  assert.doesNotMatch(actionSource, /formData\.get\(["']organizationId["']\)/);
  assert.ok(actionSource.indexOf("isCustomerId(customerId)") < updateIndex);
  assert.ok(actionSource.indexOf("parseExpectedUpdatedAt") < updateIndex);
  assert.ok(actionSource.indexOf("parseCustomerProfileForm") < updateIndex);
  assert.equal((actionSource.match(/\.from\(/g) ?? []).length, 1);
  assert.match(actionSource, /\.update\(parsed\.update\)/);
  assert.match(actionSource, /\.eq\("organization_id", workspace\.activeOrganization\.id\)/);
  assert.match(actionSource, /\.eq\("id", customerId\)/);
  assert.match(actionSource, /\.is\("deleted_at", null\)/);
  assert.match(actionSource, /\.eq\("updated_at", expected\.value\)/);
  assert.match(actionSource, /\.select\("id"\)/);
  assert.match(actionSource, /data\.length === 0/);
});

test("action keeps audit in the database and does not expose raw database messages", () => {
  assert.doesNotMatch(actionSource, /audit_log|timeline_events/);
  assert.match(actionSource, /console\.error\(/);
  assert.doesNotMatch(actionSource, /error\.message|error\.details|error\.hint/);
});

test("page and editor are capability gated and use the persisted version", () => {
  assert.match(pageSource, /capabilities\["customer\.manage"\]/);
  assert.match(pageSource, /<CustomerProfileEditor/);
  assert.match(pageSource, /updatedAt=\{overview\.updatedAt\}/);
  assert.match(loaderSource, /updatedAt: customer\.updated_at/);
  assert.match(loaderSource, /updated_at/);
  assert.match(editorSource, /name="expectedUpdatedAt"/);
  assert.match(editorSource, /value=\{updatedAt\}/);
  assert.match(editorSource, /name="customerId"/);
});

test("full gate invokes the focused test", () => {
  assert.match(gates, /customer-profile-edit\.test\.ts/);
});
