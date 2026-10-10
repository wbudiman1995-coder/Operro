import assert from "node:assert/strict";
import Module from "node:module";
import test, { before } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { ExportJobSummary } from "../src/lib/org-export";

// Renders the real client components (no Next.js runtime) with the Server Action modules stubbed,
// and asserts on the markup an owner or a non-owner would receive. Not a substitute for browser QC.
let panelModule: typeof import("../src/components/organization-export-panel");
let dashboardModule: typeof import("../src/components/dashboard-settings-form");

const STUBBED = new Set(["@/app/settings/storage/export-actions", "@/app/dashboard/actions"]);
const inert = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : name === "then" ? undefined : async () => ({ ok: false, error: null, success: null, message: "" })) });
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: ModuleLoader };
const originalLoad = internals._load;

before(async () => {
  internals._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "server-only") return {};
    if (STUBBED.has(request)) return inert;
    return originalLoad.call(this, request, parent, isMain);
  };
  panelModule = await import("../src/components/organization-export-panel");
  dashboardModule = await import("../src/components/dashboard-settings-form");
});

const job = (status: ExportJobSummary["status"], extra: Partial<ExportJobSummary> = {}): ExportJobSummary => ({
  id: "00000000-0000-4000-8000-000000000001", status, include_storage: true, created_at: "2026-10-09T01:00:00Z", completed_at: null,
  failed_reason: null, manifest_sha256: null, tables_done: 3, tables_total: 42, ...extra,
});

test("export panel is honest that this is an archive, not a restorable backup", () => {
  const html = renderToStaticMarkup(<panelModule.OrganizationExportPanel authorized jobs={[]} />);
  assert.match(html, /bukan cadangan/);
  assert.match(html, /belum ada uji pemulihan/);
  assert.match(html, /Mulai export/);
  assert.doesNotMatch(html, /backup yang aman|dapat dipulihkan sepenuhnya|disaster recovery terjamin/i);
});

test("a non-owner sees the explanation and no export controls", () => {
  const html = renderToStaticMarkup(<panelModule.OrganizationExportPanel authorized={false} jobs={[]} />);
  assert.match(html, /Hanya pemilik bisnis/);
  assert.doesNotMatch(html, /Mulai export|Lanjutkan export|Verifikasi metadata|Batalkan/);
});

test("an interrupted run is offered for resume or cancel; a completed run for metadata verification", () => {
  const running = renderToStaticMarkup(<panelModule.OrganizationExportPanel authorized jobs={[job("running")]} />);
  assert.match(running, /Lanjutkan export/);
  assert.match(running, /Batalkan/);
  assert.match(running, /3\/42 tabel/);
  const done = renderToStaticMarkup(<panelModule.OrganizationExportPanel authorized jobs={[job("completed", { manifest_sha256: "ab", completed_at: "2026-10-09T01:05:00Z" })]} />);
  assert.match(done, /Verifikasi metadata/);
  assert.doesNotMatch(done, /Lanjutkan export|Batalkan/);
});

test("dashboard settings form lists exactly the seven cards and reflects the saved visibility", () => {
  const html = renderToStaticMarkup(
    <dashboardModule.DashboardSettingsForm organizationId="org-1" visibility={{ booking_today: true, revenue_today: false, active_customers: true, open_tasks: false, performance_operations: true, performance_finance: false, performance_sources: true }} />,
  );
  for (const key of ["booking_today", "revenue_today", "active_customers", "open_tasks", "performance_operations", "performance_finance", "performance_sources"]) assert.match(html, new RegExp(`name="card_${key}"`));
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 7);
  assert.match(html, /name="card_performance_finance" value="false"/);
  assert.match(html, /name="card_revenue_today" value="false"/);
  assert.match(html, /name="card_booking_today" value="true"/);
  assert.match(html, /Data kartu tersembunyi tidak dimuat/);
  assert.doesNotMatch(html, /organization_id|name="organizationId"/);
});
