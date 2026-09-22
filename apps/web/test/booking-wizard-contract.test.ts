import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(__dirname, "..");
const action = fs.readFileSync(path.join(ROOT, "src/app/bookings/actions.ts"), "utf8");
const wizard = fs.readFileSync(path.join(ROOT, "src/components/booking-wizard.tsx"), "utf8");
const invoicing = fs.readFileSync(path.join(ROOT, "src/app/pilot-actions.ts"), "utf8");
const coverageMigration = fs.readFileSync(path.join(ROOT, "../../supabase/migrations/20260922100000_booking_package_coverage.sql"), "utf8");

test("wizard exposes separate note audiences and category discounts", () => {
  for (const label of ["Catatan pelanggan", "Instruksi untuk groomer", "Catatan internal", "Diskon per kategori"]) assert.match(wizard, new RegExp(label));
  assert.match(action, /groomer_notes: draft\.groomerNotes/);
  assert.match(action, /internal_notes: draft\.internalNotes/);
  assert.match(action, /category_discounts/);
});

test("package allocation is validated then reserved against the exact service line", () => {
  assert.match(action, /sessions_remaining/);
  assert.match(action, /item\.service_id && item\.service_id !== serviceId/);
  assert.match(action, /rpc\("reserve_package_session", \{ p_line: lineId, p_customer_package: packageId/);
  assert.match(wizard, /Bayar dengan paket/);
});

test("invoice pricing honors package coverage and snapshotted category discounts", () => {
  assert.match(invoicing, /rpc\("list_booking_package_coverage"/);
  assert.match(invoicing, /packageId \? gross/);
  assert.match(invoicing, /category_discount/);
  assert.match(invoicing, /package_coverage/);
});

test("package coverage read is a narrow invoice-issuer RPC", () => {
  assert.match(coverageMigration, /assert_tenant_authorized\(v_booking\.organization_id,'finance','invoice\.issue',v_booking\.branch_id\)/);
  assert.match(coverageMigration, /pr\.status in \('reserved','consumed'\)/);
  assert.match(coverageMigration, /revoke all on function app\.list_booking_package_coverage\(uuid\) from public/);
});
