import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  BULK_SELECTION_LIMIT,
  allVisibleSelected,
  toggleAllVisible,
  toggleSelectedId,
  visibleSelectedIds,
} from "../src/lib/customer-bulk-selection";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const actions = read("apps/web/src/app/customers/actions.ts");
const editor = read("apps/web/src/components/customer-bulk-editor.tsx");
const page = read("apps/web/src/app/customers/page.tsx");
const rls = read("supabase/tests/customer_code/rls_smoke.sql");
const gates = read("run_all_gates.sh");

test("single selection stops at the limit but selected rows remain deselectable", () => {
  let selected = new Set<string>();
  for (let index = 0; index < BULK_SELECTION_LIMIT; index += 1) selected = toggleSelectedId(selected, `id-${index}`, true);
  assert.equal(selected.size, BULK_SELECTION_LIMIT);
  selected = toggleSelectedId(selected, "id-extra", true);
  assert.equal(selected.has("id-extra"), false);
  selected = toggleSelectedId(selected, "id-0", false);
  assert.equal(selected.size, BULK_SELECTION_LIMIT - 1);
  assert.equal(selected.has("id-0"), false);
});

test("select visible changes only visible rows and respects the global limit", () => {
  const selected = toggleAllVisible(new Set(["hidden"]), ["visible-a", "visible-b"], true);
  assert.deepEqual([...selected].sort(), ["hidden", "visible-a", "visible-b"]);
  const nearlyFull = new Set(Array.from({ length: BULK_SELECTION_LIMIT - 1 }, (_, index) => `hidden-${index}`));
  const capped = toggleAllVisible(nearlyFull, ["visible-a", "visible-b"], true);
  assert.equal(capped.size, BULK_SELECTION_LIMIT);
  assert.equal(capped.has("visible-a"), true);
  assert.equal(capped.has("visible-b"), false);
});

test("clear visible works at the limit and preserves hidden selection", () => {
  const selected = new Set(Array.from({ length: BULK_SELECTION_LIMIT - 1 }, (_, index) => `hidden-${index}`));
  selected.add("visible-a");
  const cleared = toggleAllVisible(selected, ["visible-a", "visible-b"], false);
  assert.equal(cleared.size, BULK_SELECTION_LIMIT - 1);
  assert.equal(cleared.has("visible-a"), false);
  assert.equal(cleared.has("visible-b"), false);
  for (let index = 0; index < BULK_SELECTION_LIMIT - 1; index += 1) assert.equal(cleared.has(`hidden-${index}`), true);
});

test("visible selection preserves visible order and empty visibility is never all-selected", () => {
  assert.deepEqual(visibleSelectedIds(new Set(["c", "a"]), ["a", "b", "c"]), ["a", "c"]);
  assert.equal(allVisibleSelected(new Set(), []), false);
  assert.equal(allVisibleSelected(new Set(["a", "b"]), ["a", "b"]), true);
});

test("action resolves authorization and organization only on the server", () => {
  assert.match(actions, /requireActiveWorkspace/);
  assert.match(actions, /workspace\.capabilities\["customer\.manage"\]/);
  assert.doesNotMatch(actions, /loadCapabilities/);
  assert.doesNotMatch(actions, /formData\.get\(["']organizationId["']\)/);
  assert.doesNotMatch(actions, /formData\.get\(["']can[A-Za-z]+["']\)/);
  assert.match(actions, /workspace\.activeOrganization\.id/);
});

test("action bounds and validates identifiers before constructing a fixed payload", () => {
  assert.ok(actions.indexOf("rawIds.length > MAX_RAW_IDS_LENGTH") < actions.indexOf("JSON.parse(rawIds)"));
  assert.ok(actions.indexOf("parsedIds.length > MAX_CUSTOMERS") < actions.indexOf("new Set(validatedIds)"));
  assert.match(actions, /\[1-8\]\[0-9a-f\]\{3\}/);
  assert.match(actions, /\[89ab\]\[0-9a-f\]\{3\}/);
  assert.match(actions, /const payload: \{ status\?: CustomerStatus; source\?: string \| null \}/);
  assert.doesNotMatch(actions, /customer_code\s*:/);
});

test("action scopes its one customer update and reports partial results", () => {
  assert.equal((actions.match(/\.from\("customers"\)/g) ?? []).length, 1);
  assert.match(actions, /\.update\(payload\)/);
  assert.match(actions, /\.eq\("organization_id", workspace\.activeOrganization\.id\)/);
  assert.match(actions, /\.in\("id", uniqueIds\)/);
  assert.match(actions, /\.is\("deleted_at", null\)/);
  assert.match(actions, /const skipped = uniqueIds\.length - updated/);
  assert.match(actions, /updated === 0/);
});

test("UI is capability gated, bounded, visible-only, and has an explicit clear-visible control", () => {
  assert.match(page, /canManage=\{workspace\.capabilities\["customer\.manage"\]\}/);
  assert.match(editor, /BULK_SELECTION_LIMIT/);
  assert.match(editor, /JSON\.stringify\(selectedVisible\)/);
  assert.match(editor, /Bersihkan pilihan terlihat/);
  assert.match(editor, /toggleAllVisible\(current, visibleIds, false\)/);
  assert.match(editor, /disabled=\{!selectedIds\.has\(customer\.id\) && limitReached\}/);
});

test("authenticated cross-organization update uses a known hidden id and verifies unchanged ownership", () => {
  assert.match(rls, /0c300000-0000-4000-8000-0000000000c1/);
  assert.match(rls, /cross-org bulk update affected/);
  assert.match(rls, /status='active'/);
  assert.match(rls, /source is null/);
  assert.doesNotMatch(rls, /select id into v_target/);
});

test("full gate invokes the focused bulk-edit contract", () => {
  assert.match(gates, /customer-bulk-edit-contract\.test\.ts/);
});
