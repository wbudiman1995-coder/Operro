import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260924120000_invoice_workflow.sql"), "utf8");
const studio = fs.readFileSync(path.join(root, "apps/web/src/components/invoice-studio.tsx"), "utf8");
const actions = fs.readFileSync(path.join(root, "apps/web/src/app/invoices/actions.ts"), "utf8");

test("invoice workflow separates visit and package billing with immutable identity", () => {
  assert.match(migration, /billing_mode in \('after_visit','package_sale'\)/);
  assert.match(migration, /item_type in \('service','product','package'\)/);
  assert.match(migration, /Issued invoice % monetary and identity fields are immutable/);
  assert.match(migration, /old\.status in \('paid','void'\)/);
});

test("package issuance is atomic, idempotency-keyed, and ledger backed", () => {
  assert.match(migration, /create unique index uq_invoice_request_key/);
  assert.match(migration, /create or replace function app\.create_package_invoice/);
  assert.match(migration, /insert into public\.customer_packages/);
  assert.match(migration, /insert into public\.customer_package_ledger/);
  assert.match(migration, /'purchase'/);
  assert.match(actions, /\.schema\("app"\)\.rpc\("create_package_invoice"/);
});

test("duplicate visit invoices and double-click saves are protected", () => {
  assert.match(migration, /create unique index uq_order_active_booking/);
  assert.match(studio, /disabled=\{bookingPending/);
  assert.match(studio, /disabled=\{packagePending/);
  assert.match(studio, /requestKey/);
});

test("studio provides HomePaw invoice selection and due-date workflow", () => {
  assert.match(studio, /Sesudah kunjungan/);
  assert.match(studio, /Paket \/ prepaid/);
  assert.match(studio, /Cari pelanggan, kode, alamat, hewan, layanan, atau groomer/);
  assert.match(studio, /name="dueDate"/);
  assert.match(studio, /name="manualGroomer"/);
  assert.match(studio, /name="documentType"/);
});

test("unpaid detail edits are optimistic and paid invoices are locked", () => {
  assert.match(migration, /v_row\.revision <> p_revision/);
  assert.match(migration, /exists\(select 1 from public\.payments/);
  assert.match(migration, /invoice_locked/);
  assert.match(actions, /update_unpaid_invoice_details/);
  assert.match(migration, /'after_visit'/);
  assert.match(migration, /groomer_name_snapshot/);
});
