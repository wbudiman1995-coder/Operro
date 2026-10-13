import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { before } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_HOURS, describeSettingsError, formatMinutes, loadBranchHours, parseTime, SETTINGS_MAP, TIME_OPTIONS, validateCalendarHours, type BranchHours,
} from "../src/lib/business-settings";
import type { BranchAccess } from "../src/lib/authorization";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

const STUBBED = new Set(["@/app/settings/business/actions"]);
const inert = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : name === "then" ? undefined : async () => ({ error: null, success: null })) });
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: ModuleLoader };
const originalLoad = internals._load;
let BranchHoursForm: typeof import("../src/components/branch-hours-form").BranchHoursForm;
before(async () => {
  internals._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "server-only") return {};
    if (STUBBED.has(request)) return inert;
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ BranchHoursForm } = await import("../src/components/branch-hours-form"));
});

test("time helpers round-trip every quarter hour, including 24:00 as a closing time", () => {
  assert.equal(formatMinutes(510), "08:30");
  assert.equal(formatMinutes(1440), "24:00");
  assert.equal(parseTime("08:30"), 510);
  assert.equal(parseTime("24:00"), 1440);
  for (const bad of ["8:30", "08:60", "25:00", "24:15", "", "ab:cd", "08:30:00"]) assert.equal(parseTime(bad), null, bad);
  assert.equal(TIME_OPTIONS.length, 97);
  for (const minutes of TIME_OPTIONS) assert.equal(parseTime(formatMinutes(minutes)), minutes);
});

test("calendar-hours validation uses exactly the database bounds (same vectors as the SQL test)", () => {
  const accepted: Array<[number | null, number | null]> = [[480, 1200], [0, 120], [1320, 1440], [510, 1080], [null, null]];
  for (const [start, end] of accepted) assert.equal(validateCalendarHours(start, end).ok, true, `${start}-${end}`);
  const rejected: Array<[number | null, number | null]> = [[500, 1140], [600, 660], [600, 1500], [-15, 600], [1380, 1440], [900, 600], [600, null], [null, 600], [600.5, 1200], [0, 105]];
  for (const [start, end] of rejected) assert.equal(validateCalendarHours(start, end).ok, false, `${start}-${end}`);
  assert.match((validateCalendarHours(600, 660) as { message: string }).message, /minimal 2 jam/);
});

function branchClient(rows: Array<Record<string, unknown>>) {
  const filters: string[] = [];
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (column: string, value: unknown) => { filters.push(`${column}=${String(value)}`); return b; },
    is: (column: string) => { filters.push(`${column} is null`); return b; },
    order: () => b,
    then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: null }),
  };
  return { filters, client: { from: () => b } as never };
}

test("branch hours: only branches the caller may reach, stored vs default shown, malformed settings fall back, the token is kept verbatim", async () => {
  const { client, filters } = branchClient([
    { id: "b1", name: "North", settings: { schedule: { dayStartMinutes: 480, dayEndMinutes: 1200, other: 1 } }, updated_at: "2026-10-12T01:02:03.123456+00:00" },
    { id: "b2", name: "South", settings: {}, updated_at: "2026-10-12T01:02:03.5+00:00" },
    { id: "b3", name: "Weird", settings: { schedule: { dayStartMinutes: 500, dayEndMinutes: 1100 } }, updated_at: "t3" },
    { id: "b4", name: "Hidden", settings: [], updated_at: "t4" },
  ]);
  const all: BranchAccess = { all: true, ids: new Set() };
  const hours = await loadBranchHours(client, "org", all);
  assert.equal(hours.length, 4);
  assert.deepEqual(hours[0], { id: "b1", name: "North", updatedAt: "2026-10-12T01:02:03.123456+00:00", storedStart: 480, storedEnd: 1200, effectiveStart: 480, effectiveEnd: 1200 });
  assert.deepEqual([hours[1].storedStart, hours[1].effectiveStart, hours[1].effectiveEnd], [null, DEFAULT_HOURS.start, DEFAULT_HOURS.end]);
  assert.equal(hours[2].storedStart, null, "an invalid stored value is shown as the default, not as a custom setting");
  assert.ok(filters.includes("organization_id=org") && filters.includes("status=active") && filters.includes("deleted_at is null"));
  const limited = await loadBranchHours(client, "org", { all: false, ids: new Set(["b2"]) });
  assert.deepEqual(limited.map((branch) => branch.id), ["b2"], "a branch-limited caller never sees other branches");
  assert.deepEqual(await loadBranchHours(client, "org", { all: false, ids: new Set() }), []);
});

const branch = (extra: Partial<BranchHours> = {}): BranchHours => ({ id: "11111111-1111-4111-8111-111111111111", name: "North", updatedAt: "2026-10-12T01:02:03.123456+00:00", storedStart: 480, storedEnd: 1200, effectiveStart: 480, effectiveEnd: 1200, ...extra });

test("form: carries the branch and the verbatim token, never an organization; read-only roles get no write control", () => {
  const html = renderToStaticMarkup(<BranchHoursForm branch={branch()} canEdit />);
  assert.match(html, /name="branchId" value="11111111-1111-4111-8111-111111111111"/);
  assert.match(html, /name="updatedAt" value="2026-10-12T01:02:03.123456\+00:00"/);
  assert.match(html, /<option value="08:00" selected="">08:00<\/option>/);
  assert.match(html, /<option value="20:00" selected="">20:00<\/option>/);
  assert.match(html, /Diatur pemilik/);
  assert.match(html, /<button[^>]*value="save"[^>]*name="intent"|<button[^>]*name="intent"[^>]*value="save"/);
  assert.match(html, /<button[^>]*value="reset"[^>]*name="intent"|<button[^>]*name="intent"[^>]*value="reset"/);
  assert.doesNotMatch(html, /organization|settings/i);
  const reader = renderToStaticMarkup(<BranchHoursForm branch={branch()} canEdit={false} />);
  assert.doesNotMatch(reader, /name="intent"/);
  assert.match(reader, /Hanya pemilik atau peran dengan branches\.manage/);
  assert.match(reader, /<select[^>]*disabled=""/);
  const defaults = renderToStaticMarkup(<BranchHoursForm branch={branch({ storedStart: null, storedEnd: null, effectiveStart: DEFAULT_HOURS.start, effectiveEnd: DEFAULT_HOURS.end })} canEdit />);
  assert.match(defaults, /Bawaan 08:30–18:00/);
  assert.match(defaults, /<button[^>]*value="reset"[^>]*disabled=""|<button[^>]*disabled=""[^>]*value="reset"/, "reset is disabled when nothing is customised");
});

test("error text is plain language and never raw", () => {
  assert.match(describeSettingsError({ code: "40001" }), /diubah oleh orang lain/);
  assert.match(describeSettingsError({ code: "42501" }), /branches\.manage/);
  assert.match(describeSettingsError({ code: "22023" }), /kelipatan 15 menit/);
  assert.doesNotMatch(describeSettingsError({ code: "XX000", message: "relation public.branches" }), /relation|public/);
});

test("settings map: distinguishes organization, branch, personal and platform scope and refuses to pretend unmapped keys exist", () => {
  const scopes = new Set(SETTINGS_MAP.map((row) => row.scope));
  for (const scope of ["Organisasi", "Cabang", "Pribadi", "Platform"]) assert.ok(scopes.has(scope as never), scope);
  assert.deepEqual(SETTINGS_MAP.filter((row) => row.href === null).map((row) => row.homepaw), ["(currency)", "(billing plan, quota)"], "only currency and platform billing remain without a business-owned home, and they are listed without a fake link");
  const sourceLabels = SETTINGS_MAP.find((row) => row.homepaw === "sourceLabels")!;
  assert.equal(sourceLabels.href, "/settings/business");
  assert.match(sourceLabels.note, /hanya saran/i);
  assert.match(SETTINGS_MAP.find((row) => row.homepaw === "dueDayDefault")!.note, /invoice yang sudah ada tidak berubah/);
  assert.match(SETTINGS_MAP.find((row) => row.homepaw === "(currency)")!.note, /mencampur riwayat/);
  assert.equal(SETTINGS_MAP.find((row) => row.scope === "Pribadi")!.href, "/settings/preferences");
  for (const row of SETTINGS_MAP) if (row.href) assert.match(row.href, /^\/[a-z/-]+$/, `${row.label} links internally`);
  assert.equal(new Set(SETTINGS_MAP.map((row) => row.homepaw)).size, SETTINGS_MAP.length);
});

test("action and migration: typed RPC only, token shape checked, no arbitrary settings write", () => {
  const action = read("apps/web/src/app/settings/business/actions.ts");
  assert.match(action, /rpc\("set_branch_calendar_hours"/);
  assert.doesNotMatch(action, /\.from\("(branches|organizations)"\)\s*\.(update|insert|upsert)/);
  assert.doesNotMatch(action, /formData\.get(All)?\("(?:settings|json|organization|org)/);
  assert.match(action, /TOKEN\.test\(token\)/);
  const page = read("apps/web/src/app/settings/business/page.tsx");
  assert.doesNotMatch(page, /<textarea|JSON\.parse|dangerouslySetInnerHTML/);
  const sql = read("supabase/migrations/20261031140000_business_settings.sql");
  assert.match(sql, /security definer set search_path = ''/);
  assert.match(sql, /stale_branch/);
  assert.match(sql, /p_start_minutes % 15 <> 0/);
  assert.match(sql, /revoke all on function app\.set_branch_calendar_hours\(uuid, integer, integer, timestamptz\) from public, anon, authenticated/);
  const schedule = read("apps/web/src/lib/schedule.ts");
  assert.match(schedule, /export function readConfiguredHours/);
});
