import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { before } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { describeScheduleState, loadCleanupScheduleState, parseScheduleState, UNATTENDED_CLEANUP_AVAILABLE, type CleanupScheduleState } from "../src/lib/cleanup-schedule";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

const STUBBED = new Set(["@/app/settings/storage/schedule-actions"]);
const inert = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : name === "then" ? undefined : async () => ({ error: null, success: null })) });
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: ModuleLoader };
const originalLoad = internals._load;
let Panel: typeof import("../src/components/cleanup-schedule-panel").CleanupSchedulePanel;
before(async () => {
  internals._load = function (request: string, parent: unknown, isMain: boolean) {
    if (STUBBED.has(request)) return inert;
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ CleanupSchedulePanel: Panel } = await import("../src/components/cleanup-schedule-panel"));
});

const state = (extra: Partial<CleanupScheduleState> = {}): CleanupScheduleState => ({ enabled: false, cadence: "weekly", changedAt: null, disabledAt: null, lastApplyAt: null, lastApplyStatus: null, ...extra });

test("the repository has no scheduler or service identity, which is why the availability flag is false", () => {
  assert.equal(UNATTENDED_CLEANUP_AVAILABLE, false);
  // If any of these appears, a runner may exist: review it, then flip the flag deliberately.
  assert.equal(fs.existsSync(path.join(root, "vercel.json")), false, "no root vercel.json (and so no Vercel Cron)");
  assert.equal(fs.existsSync(path.join(root, "apps/web/vercel.json")), false, "no apps/web/vercel.json");
  const appDir = path.join(root, "apps/web/src/app");
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const files = walk(appDir);
  assert.deepEqual(files.filter((file) => /[\\/](cron|jobs?|scheduled|worker)[\\/]/i.test(file)), [], "no cron/job/worker route exists");
  const sources = walk(path.join(root, "apps/web/src")).filter((file) => /\.(ts|tsx)$/.test(file));
  const offenders = sources.filter((file) => /SUPABASE_SERVICE_ROLE|service_role|createClient\([^)]*serviceRole/i.test(fs.readFileSync(file, "utf8")) && !/health-recovery|recovery-drill|authorization\.ts$/.test(file));
  assert.deepEqual(offenders.map((file) => path.relative(root, file)), [], "no service-role client in the web app");
  const migrations = fs.readdirSync(path.join(root, "supabase/migrations")).filter((name) => name.endsWith(".sql"));
  const cron = migrations.filter((name) => /pg_cron|cron\.schedule/i.test(fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8").replace(/^\s*--.*$/gm, "")));
  assert.deepEqual(cron, [], "no migration schedules a database job (comments excluded)");
});

test("state parsing is defensive; a missing or malformed state is 'not shown', never 'off'", async () => {
  assert.equal(parseScheduleState(null), null);
  assert.equal(parseScheduleState({ cadence: "weekly" }), null);
  assert.equal(parseScheduleState({ enabled: "yes" }), null);
  assert.deepEqual(parseScheduleState({ enabled: true, cadence: "monthly", changed_at: "t", disabled_at: null, last_apply_at: "u", last_apply_status: "completed" }),
    { enabled: true, cadence: "monthly", changedAt: "t", disabledAt: null, lastApplyAt: "u", lastApplyStatus: "completed" });
  assert.equal(parseScheduleState({ enabled: false, cadence: "hourly" })!.cadence, "weekly", "an unknown cadence falls back to the safe default");
  const denied = { schema: () => ({ rpc: async () => ({ data: null, error: { code: "42501", message: "x" } }) }) };
  assert.equal(await loadCleanupScheduleState(denied as never), null);
  const ok = { schema: () => ({ rpc: async () => ({ data: { enabled: false, cadence: "weekly" }, error: null }) }) };
  assert.equal((await loadCleanupScheduleState(ok as never))?.enabled, false);
});

test("wording: off says how cleanup really happens; consent without a runner says nothing will run; only a real runner may say active", () => {
  assert.equal(describeScheduleState(state()).tone, "off");
  assert.match(describeScheduleState(state()).detail, /menjalankannya sendiri setelah pratinjau/);
  const consent = describeScheduleState(state({ enabled: true, cadence: "monthly" }));
  assert.equal(consent.tone, "consent_only");
  assert.match(consent.headline, /bulanan.*belum ada penjadwal/);
  assert.match(consent.detail, /tidak ada pembersihan otomatis yang berjalan atau akan berjalan/);
  assert.equal(describeScheduleState(state({ enabled: true }), true).tone, "active");
  assert.doesNotMatch(consent.headline + consent.detail, /aktif/i, "consent alone is never described as active");
  assert.equal(describeScheduleState(state({ disabledAt: "2026-10-01T00:00:00Z" })).tone, "off");
});

test("panel: owner sees the consent switch and the no-runner statement; non-owners and unknown state get honest alternatives", () => {
  const owner = renderToStaticMarkup(<Panel state={state({ enabled: true })} canEdit />);
  assert.match(owner, /belum ada penjadwal/);
  assert.match(owner, /Matikan sekarang/);
  assert.match(owner, /aria-label="Persetujuan pembersihan otomatis"/);
  const off = renderToStaticMarkup(<Panel state={state()} canEdit />);
  assert.match(off, /Catat persetujuan/);
  assert.match(off, /Pembersihan otomatis: mati/);
  const reader = renderToStaticMarkup(<Panel state={state({ enabled: true })} canEdit={false} />);
  assert.doesNotMatch(reader, /<form/);
  assert.match(reader, /Hanya pemilik bisnis/);
  const unknown = renderToStaticMarkup(<Panel state={null} canEdit />);
  assert.match(unknown, /Status persetujuan tidak ditampilkan/);
  assert.match(unknown, /bukan tanda bahwa pembersihan otomatis mati/);
  const withHistory = renderToStaticMarkup(<Panel state={state({ lastApplyAt: "2026-10-01T00:00:00Z", lastApplyStatus: "partial" })} canEdit />);
  assert.match(withHistory, /Pembersihan terakhir/);
  assert.doesNotMatch(owner + off + withHistory, /(GB|MB)|Rp\s?\d|biaya|harga|kuota/i, "no provider quota or billing figure appears");
});

test("action and migration: owner-only RPC, no deletion, no runner", () => {
  const action = read("apps/web/src/app/settings/storage/schedule-actions.ts");
  assert.match(action, /rpc\("set_storage_cleanup_schedule"/);
  assert.doesNotMatch(action, /storage\.from|\.remove\(|storage_cleanup_begin|storage_cleanup_record|fetch\(/);
  const sql = read("supabase/migrations/20261031150000_cleanup_schedule_consent.sql");
  assert.match(sql, /enabled boolean not null default false/);
  assert.match(sql, /is_business_owner_member\(v_org\)/);
  assert.doesNotMatch(sql.replace(/^\s*--.*$/gm, ""), /pg_cron|cron\.schedule|http_post|net\.http/i);
});
