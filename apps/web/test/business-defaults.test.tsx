import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { BusinessDefaultsForm } from "../src/components/business-defaults-form";
import { SourceSuggestions } from "../src/components/source-suggestions";
import {
  describeDefaultsError, dueDateFor, loadBusinessDefaults, loadSourceSuggestions, MAX_SOURCE_LABELS, NO_DEFAULTS, parseBusinessDefaults, parseLabelsText, SOURCE_SUGGESTION_LIST_ID,
  validateDefaultsForm,
} from "../src/lib/business-defaults";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

test("stored defaults are parsed defensively and an absent row means 'no defaults'", () => {
  assert.deepEqual(parseBusinessDefaults(null), NO_DEFAULTS);
  assert.deepEqual(parseBusinessDefaults([]), NO_DEFAULTS);
  assert.deepEqual(parseBusinessDefaults([{ source_labels: ["Instagram", "", 5, "Teman"], invoice_due_days: "7", version: 3 }]), { sourceLabels: ["Instagram", "Teman"], invoiceDueDays: 7, version: 3 });
  assert.equal(parseBusinessDefaults([{ source_labels: [], invoice_due_days: 999, version: 1 }]).invoiceDueDays, null, "an out-of-range stored period is ignored, never trusted");
  assert.equal(parseBusinessDefaults([{ source_labels: [], invoice_due_days: -1, version: 1 }]).invoiceDueDays, null);
  assert.equal(parseBusinessDefaults([{ source_labels: [], invoice_due_days: null, version: "x" }]).version, 0);
  assert.equal(parseBusinessDefaults([{ source_labels: Array.from({ length: 30 }, (_, index) => `L${index}`), invoice_due_days: 0, version: 1 }]).sourceLabels.length, MAX_SOURCE_LABELS);
  assert.equal(parseBusinessDefaults([{ source_labels: [], invoice_due_days: 0, version: 1 }]).invoiceDueDays, 0, "zero days (due the same day) is a real value");
});

test("labels text is normalized one label per line", () => {
  assert.deepEqual(parseLabelsText("  Instagram \r\n\r\nTeman   dekat\n \nGoogle"), ["Instagram", "Teman dekat", "Google"]);
  assert.deepEqual(parseLabelsText(""), []);
});

test("the form is checked the way the database checks it", () => {
  assert.deepEqual(validateDefaultsForm({ labelsText: "Instagram\nTeman", dueDays: "7", version: "2" }), { ok: true, labels: ["Instagram", "Teman"], dueDays: 7, version: 2 });
  assert.deepEqual(validateDefaultsForm({ labelsText: "", dueDays: "", version: "0" }), { ok: true, labels: [], dueDays: null, version: 0 });
  assert.deepEqual(validateDefaultsForm({ labelsText: "A", dueDays: "0", version: "0" }), { ok: true, labels: ["A"], dueDays: 0, version: 0 });
  assert.deepEqual(validateDefaultsForm({ labelsText: "A", dueDays: "365", version: "0" }), { ok: true, labels: ["A"], dueDays: 365, version: 0 });
  const tooMany = Array.from({ length: MAX_SOURCE_LABELS + 1 }, (_, index) => `L${index}`).join("\n");
  for (const bad of [
    { labelsText: tooMany, dueDays: "", version: "0" }, { labelsText: "x".repeat(41), dueDays: "", version: "0" }, { labelsText: "Instagram\ninstagram", dueDays: "", version: "0" },
    { labelsText: "A  b\na b", dueDays: "", version: "0" }, { labelsText: "bad\u0001", dueDays: "", version: "0" }, { labelsText: "A", dueDays: "366", version: "0" },
    { labelsText: "A", dueDays: "-1", version: "0" }, { labelsText: "A", dueDays: "7.5", version: "0" }, { labelsText: "A", dueDays: "abc", version: "0" }, { labelsText: "A", dueDays: "1000", version: "0" },
    { labelsText: "A", dueDays: "", version: "-1" }, { labelsText: "A", dueDays: "", version: "x" },
  ]) assert.equal(validateDefaultsForm(bad).ok, false, JSON.stringify(bad).slice(0, 80));
});

test("database errors become plain language and never leak raw text", () => {
  assert.match(describeDefaultsError({ code: "42501" }), /settings\.manage/);
  assert.match(describeDefaultsError({ code: "40001", message: "stale_defaults" }), /diubah orang lain/);
  assert.match(describeDefaultsError({ code: "22023", message: "invalid_source_labels" }), /duplikat/);
  assert.doesNotMatch(describeDefaultsError({ code: "XX000", message: "relation organization_business_defaults broke" }), /relation|organization_business_defaults/);
});

test("the default due date is the issue date plus the period, else the day after, across month ends and leap days", () => {
  assert.equal(dueDateFor("2026-10-13", null), "2026-10-14", "no default keeps today's behavior");
  assert.equal(dueDateFor("2026-10-13", 0), "2026-10-13");
  assert.equal(dueDateFor("2026-10-13", 7), "2026-10-20");
  assert.equal(dueDateFor("2026-10-28", 7), "2026-11-04");
  assert.equal(dueDateFor("2026-12-30", 3), "2027-01-02");
  assert.equal(dueDateFor("2028-02-27", 2), "2028-02-29");
  assert.equal(dueDateFor("2026-01-01", 365), "2027-01-01");
});

type Reply = { data: unknown; error: { code?: string; message: string } | null };
const tableClient = (reply: Reply) => {
  const seen: string[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "limit", "eq"]) builder[method] = (...args: unknown[]) => { seen.push(`${method}:${args.map(String).join(",")}`); return builder; };
  builder.then = (resolve: (value: unknown) => void) => resolve(reply);
  return { seen, client: { from: (table: string) => { seen.push(`from:${table}`); return builder; } } as never };
};

test("reading goes through row-level security only and a failed suggestion read never blocks a form", async () => {
  const ok = tableClient({ data: [{ source_labels: ["Instagram"], invoice_due_days: 7, version: 1 }], error: null });
  assert.deepEqual(await loadBusinessDefaults(ok.client), { sourceLabels: ["Instagram"], invoiceDueDays: 7, version: 1 });
  assert.ok(ok.seen.includes("from:organization_business_defaults"));
  assert.equal(ok.seen.some((entry) => entry.startsWith("eq:")), false, "no organization filter is sent from the browser side");
  assert.deepEqual(await loadSourceSuggestions(ok.client), ["Instagram"]);
  const missing = tableClient({ data: null, error: { code: "PGRST205", message: "table not found" } });
  assert.deepEqual(await loadSourceSuggestions(missing.client), []);
  const broken = tableClient({ data: null, error: { code: "XX000", message: "boom" } });
  const originalError = console.error;
  console.error = () => undefined;
  try { assert.deepEqual(await loadSourceSuggestions(broken.client), []); } finally { console.error = originalError; }
  await assert.rejects(() => loadBusinessDefaults(broken.client), (error: Error & { code?: string }) => error.code === "XX000");
});

test("the settings form shows saved values, hides the save button from a read-only member and says what the values do", () => {
  const defaults = { sourceLabels: ["Instagram", "Teman"], invoiceDueDays: 7, version: 3 };
  const editable = renderToStaticMarkup(<BusinessDefaultsForm defaults={defaults} canEdit={true} />);
  assert.match(editable, /Instagram\nTeman|Instagram&#10;Teman|Instagram\r?\nTeman/);
  assert.match(editable, /name="version" value="3"/);
  assert.match(editable, /value="7"/);
  assert.match(editable, /Simpan bawaan/);
  assert.match(editable, /Hanya saran di formulir/);
  assert.match(editable, /Invoice yang sudah ada tidak berubah/);
  const readOnly = renderToStaticMarkup(<BusinessDefaultsForm defaults={defaults} canEdit={false} />);
  assert.doesNotMatch(readOnly, /Simpan bawaan/);
  assert.match(readOnly, /settings\.manage/);
  assert.match(readOnly, /disabled/);
  const empty = renderToStaticMarkup(<BusinessDefaultsForm defaults={NO_DEFAULTS} canEdit={true} />);
  assert.match(empty, /name="version" value="0"/);
  assert.match(empty, /Kosong = hari berikutnya/);
});

test("suggestions render as a datalist and nothing when there are none", () => {
  const html = renderToStaticMarkup(<SourceSuggestions labels={["Instagram", "Teman"]} />);
  assert.match(html, new RegExp(`<datalist id="${SOURCE_SUGGESTION_LIST_ID}">`));
  assert.match(html, /<option value="Instagram"/);
  assert.equal(renderToStaticMarkup(<SourceSuggestions labels={[]} />), "");
});

test("customer source inputs only SUGGEST (free text stays valid) and the invoice studio keeps its old default without a period", () => {
  for (const file of ["apps/web/src/components/customer-profile-editor.tsx", "apps/web/src/components/customer-bulk-editor.tsx", "apps/web/src/components/onboarding-admin.tsx"]) {
    assert.match(read(file), /name="source" list="source-label-suggestions"/, `${file} points at the suggestion list`);
    assert.doesNotMatch(read(file), /<select[^>]*name="source"/, `${file} did not turn source into a closed list`);
  }
  const studio = read("apps/web/src/components/invoice-studio.tsx");
  assert.match(studio, /dueDays\?: number \| null/);
  assert.match(studio, /dueDays === null \? nextDate\(value\) : addDays\(value, dueDays\)/);
  assert.doesNotMatch(studio, /setDueDate\(nextDate\(/, "the due date is always computed through the default");
  assert.match(studio, /name="dueDate"/, "the due date stays an editable field");
  assert.match(read("apps/web/src/app/invoices/new/page.tsx"), /dueDays=\{defaults\.invoiceDueDays\}/);
  assert.match(read("apps/web/src/app/invoices/new/page.tsx"), /\.catch\(\(\) => NO_DEFAULTS\)/, "an older database or a failed read keeps today's behavior");
});

test("the action sends only the two values and a version, and no organization", () => {
  const actions = read("apps/web/src/app/settings/business/actions.ts");
  const save = actions.slice(actions.indexOf("export async function saveBusinessDefaultsAction"));
  assert.match(save, /p_source_labels: checked\.labels, p_invoice_due_days: checked\.dueDays, p_expected_version: checked\.version/);
  assert.doesNotMatch(save, /p_org\b|organization_id|activeOrganization/);
});
