import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  parseSizeMatrix,
  perDogDetailRows,
  sizeMatrixRows,
  UNSIZED_LABEL,
  type PayrollSizeBand,
} from "../src/lib/payroll-size-matrix";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const migration = read("supabase/migrations/20261027100000_size_band_payroll.sql");
const actions = read("apps/web/src/app/payroll/payroll-actions.ts");
const form = read("apps/web/src/components/payroll-settings-form.tsx");
const data = read("apps/web/src/lib/payroll-data.ts");
const page = read("apps/web/src/app/payroll/page.tsx");
const gates = read("run_all_gates.sh");

const band = (key: string, label: string, sortOrder: number, status: "active" | "archived" = "active"): PayrollSizeBand => ({ key, label, sortOrder, status });
// A tenant with the five legacy bands renamed, a sixth band, and one archived custom band.
const tenant: PayrollSizeBand[] = [
  band("extra_small", "Mini", 10), band("small", "S", 20), band("medium", "M", 30), band("large", "L", 40),
  band("extra_large", "XL", 50), band("xxl", "XXL", 60), band("giant", "Giant", 70, "archived"),
];

test("matrix keys come from the tenant's own bands: legacy XS-XL and a sixth band are accepted", () => {
  const result = parseSizeMatrix(JSON.stringify({ extra_small: 11000, small: 12000, xxl: 22000, extra_large: 0 }), tenant, null);
  assert.deepEqual(result, { ok: true, value: { extra_small: 11000, small: 12000, xxl: 22000, extra_large: 0 } });
});

test("a blank or missing field stays absent while an explicit 0 is kept as a deliberate zero", () => {
  assert.deepEqual(parseSizeMatrix("", tenant, null), { ok: true, value: {} });
  assert.deepEqual(parseSizeMatrix(null, tenant, null), { ok: true, value: {} });
  assert.deepEqual(parseSizeMatrix("{}", tenant, null), { ok: true, value: {} });
  assert.deepEqual(parseSizeMatrix('{"small":0}', tenant, null), { ok: true, value: { small: 0 } });
});

test("unknown, cross-tenant and cat keys are refused before the database sees them", () => {
  const other: PayrollSizeBand[] = [band("extra_small", "XS", 10), band("small", "S", 20)];
  const crossTenant = parseSizeMatrix('{"xxl":22000}', other, null);
  assert.equal(crossTenant.ok, false);
  assert.match(crossTenant.ok ? "" : crossTenant.error, /tidak dikenal/);
  assert.equal(parseSizeMatrix('{"cat":1000}', tenant, null).ok, false);
  assert.equal(parseSizeMatrix('{"__proto__":1}', tenant, null).ok, false);
  assert.equal(parseSizeMatrix('{"constructor":1}', tenant, null).ok, false);
});

test("archived keys: unchanged stored rate is tolerated, a new or changed rate is refused", () => {
  const stored = { giant: 30000, small: 12000 };
  assert.deepEqual(parseSizeMatrix('{"giant":30000,"small":13000}', tenant, stored), { ok: true, value: { giant: 30000, small: 13000 } });
  const changed = parseSizeMatrix('{"giant":31000}', tenant, stored);
  assert.equal(changed.ok, false);
  assert.match(changed.ok ? "" : changed.error, /diarsipkan/);
  assert.equal(parseSizeMatrix('{"giant":30000}', tenant, null).ok, false);
  assert.equal(parseSizeMatrix('{"giant":30000}', tenant, { small: 1 }).ok, false);
  // clearing it is just omitting it
  assert.deepEqual(parseSizeMatrix('{"small":12000}', tenant, stored), { ok: true, value: { small: 12000 } });
});

test("malformed matrices are refused", () => {
  for (const raw of ["not json", "[1]", "null", '"x"', '{"small":-1}', '{"small":"abc"}', '{"small":null}', '{"small":"12000"}', '{"small":1e15}', '{"small":true}']) {
    assert.equal(parseSizeMatrix(raw, tenant, null).ok, false, raw);
  }
});

test("editor rows: active bands in weight order plus archived bands only while they still hold a rate", () => {
  const rows = sizeMatrixRows([...tenant].reverse(), { small: 12000, giant: 30000 });
  assert.deepEqual(rows.map((row) => row.key), ["extra_small", "small", "medium", "large", "extra_large", "xxl", "giant"]);
  assert.deepEqual(rows.map((row) => row.label), ["Mini", "S", "M", "L", "XL", "XXL", "Giant"]);
  assert.equal(rows.find((row) => row.key === "giant")?.archived, true);
  assert.equal(rows.find((row) => row.key === "small")?.value, 12000);
  assert.equal(rows.find((row) => row.key === "xxl")?.value, null);
  assert.equal(sizeMatrixRows(tenant, null).some((row) => row.key === "giant"), false);
  assert.equal(sizeMatrixRows(tenant, { giant: 0 }).find((row) => row.key === "giant")?.value, 0);
});

test("perDogDetail reads frozen per-size rows and tolerates results calculated before SB-06", () => {
  assert.deepEqual(perDogDetailRows(undefined), []);
  assert.deepEqual(perDogDetailRows({ small: 1 }), []);
  assert.deepEqual(perDogDetailRows([{ key: "xxl", label: "XXL", count: 2, rate: 22000, amount: 44000 }, { key: null, label: null, count: 3, rate: 20000, amount: 60000 }, "bad", { count: "x" }]),
    [{ key: "xxl", label: "XXL", count: 2, rate: 22000, amount: 44000 }, { key: null, label: null, count: 3, rate: 20000, amount: 60000 }]);
  assert.match(UNSIZED_LABEL, /flat/);
});

test("server actions validate against the tenant's bands, not a fixed key list or caller-supplied organization", () => {
  assert.doesNotMatch(actions, /SIZE_KEYS|extra_large|"small"|parseSizeMatrixJson/);
  assert.match(actions, /loadPayrollSizeBands\(context\.supabase, context\.organizationId\)/);
  assert.match(actions, /parseSizeMatrix\(raw, bands, stored\)/);
  // the organization comes from the authenticated context, never the form
  assert.doesNotMatch(actions, /formData\.get\("organization/);
  // inherited/blank semantics are preserved: an empty staff matrix is SQL NULL, never {}
  assert.match(actions, /per_pet_size_matrix: Object\.keys\(matrix\.value\)\.length > 0 \? matrix\.value : null/);
  assert.match(actions, /per_pet_size_matrix_default: matrix\.value/);
  assert.match(actions, /payroll_size_key_invalid/);
});

test("settings UI takes labels and keys from the loaded bands, with no built-in map", () => {
  assert.doesNotMatch(form, /SIZE_LABELS|Extra besar|"extra_large"/);
  assert.match(form, /sizeMatrixRows\(bands, initial\)/);
  assert.match(form, /sizeBands: PayrollSizeBand\[\]/);
  assert.match(page, /sizeBands=\{data\.sizeBands\}/);
  assert.match(data, /from\("organization_size_bands"\)/);
  assert.match(data, /eq\("band_kind", "dog_weight"\)/);
});

test("SB-06 migration: one authoritative sizing path, no caller-supplied key/label/org/amount, frozen results untouched", () => {
  assert.match(migration, /app\.pet_pricing_key\(p_org, p_species, p_weight, p_stored_size\)/);
  assert.doesNotMatch(migration, /group by pt\.size/);
  assert.match(migration, /app\.payroll_pet_size_key\(p_org, pt\.species, pt\.weight_kg, pt\.size\)/);
  // never rewrites payroll history or booking/invoice/package snapshots
  assert.doesNotMatch(migration, /\b(update|delete\s+from)\s+public\.(payroll_|grooming_job_pet_services|invoices|customer_packages|packages|pets)/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.payroll_/i);
  // tight definer/search_path/grants
  assert.doesNotMatch(migration, /grant execute[^;]*to (anon|public)/i);
  assert.match(migration, /revoke all on function app\.compute_payroll_item\(uuid, uuid, date, date\)/);
  assert.match(migration, /revoke all on function app\.payroll_export_detail_rows\(uuid, date, date\) from public, anon;/);
  assert.match(migration, /grant execute on function app\.payroll_export_detail_rows\(uuid, date, date\) to authenticated;/);
  assert.match(migration, /app\.has_permission\('payroll\.read'\)/);
  assert.doesNotMatch(migration, /security definer(?! set search_path)/);
  assert.match(migration, /to_jsonb\(new\) -> v_col/);
  // forward-only: the accepted payroll and size-band migrations are untouched
  assert.match(gates, /20261027100000_size_band_payroll\.sql/);
});

test("the matrix validation fires on insert and on updates of the matrix column of both settings tables", () => {
  assert.match(migration, /create trigger trg_pcs_validate_size_matrix\s+before insert or update of per_pet_size_matrix_default on public\.payroll_cycle_settings/);
  assert.match(migration, /create trigger trg_sps_validate_size_matrix\s+before insert or update of per_pet_size_matrix on public\.staff_payroll_settings/);
});

test("payroll gates: dynamic payroll smoke and this suite are wired", () => {
  assert.match(gates, /integration\/size_band_payroll_smoke\.sql/);
  assert.match(gates, /test\/payroll-dynamic-size\.test\.ts/);
});

// ---- export workbook (server-only stubbed so the real builder runs) ----
// "server-only" is a Next.js build-time guard with no runtime package here; resolve it to an empty module.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeModule = require("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = nodeModule._load;
nodeModule._load = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? {} : originalLoad.call(this, request, ...rest);
};

test("XLSX detail sheet shows the server-derived label and the immutable booking-line size, not raw keys", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildPayrollWorkbook, detailSizeText } = require("../src/lib/payroll-export") as typeof import("../src/lib/payroll-export");
  assert.equal(detailSizeText({ petSize: "xxl", petSizeLabel: "XXL" }), "XXL");
  assert.equal(detailSizeText({ petSize: null, petSizeLabel: null }), "");
  const buffer = await buildPayrollWorkbook({
    organizationName: "Tenant", currency: "IDR", periodStart: "2026-04-26", periodEnd: "2026-05-26", label: "x", runStatus: "paid",
    staff: [], missing: [],
    detail: [
      { bookingId: "b1", membershipId: "m1", staffName: "A", startsAt: "2026-05-01T02:00:00Z", customerName: "C", petName: "Rex", petSize: "extra_large",
        petSizeLabel: "XL", services: "Basic", serviceRevenue: 100000, invoiceNumber: "INV-1", invoiceStatus: "paid",
        serviceSizeKey: "xxl", serviceSizeLabel: "XXL (lama)" },
      { bookingId: "b2", membershipId: "m1", staffName: "A", startsAt: "2026-05-01T03:00:00Z", customerName: "C", petName: "Mimi", petSize: null,
        petSizeLabel: null, services: "Basic", serviceRevenue: 90000, invoiceNumber: "INV-1", invoiceStatus: "paid",
        serviceSizeKey: null, serviceSizeLabel: null },
    ],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet("Detail Job")!;
  const headers = (sheet.getRow(1).values as unknown[]).slice(1);
  assert.deepEqual(headers.slice(0, 5), ["Tanggal", "Groomer", "Owner", "Hewan", "Ukuran"]);
  assert.equal(headers[headers.length - 1], "Ukuran saat layanan");
  const rex = sheet.getRow(2).values as unknown[];
  assert.equal(rex[4], "Rex"); assert.equal(rex[5], "XL");
  assert.equal(rex[rex.length - 1], "XXL (lama)");
  const mimi = sheet.getRow(3).values as unknown[];
  assert.ok(mimi[5] === "" || mimi[5] === undefined || mimi[5] === null);
  assert.ok(!JSON.stringify(sheet.getRow(2).values).includes("extra_large"));
});
