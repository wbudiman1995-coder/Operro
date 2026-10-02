import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const migration = read("supabase/migrations/20261022110000_customer_codes.sql");
const pilotData = read("apps/web/src/lib/pilot-data.ts");
const customer360 = read("apps/web/src/lib/customer-360.ts");
const customer360Component = read("apps/web/src/components/customer-360.tsx");
const search = read("apps/web/src/lib/search.ts");
const customerDatabase = read("apps/web/src/components/customer-database.tsx");
const exportsSource = read("apps/web/src/lib/homepaw-export.ts");
const invoiceWorkspace = read("apps/web/src/lib/invoice-workspace.ts");
const invoiceStudio = read("apps/web/src/components/invoice-studio.tsx");
const gates = read("run_all_gates.sh");

test("migration owns stable tenant-scoped allocation without a 999 truncation", () => {
  assert.match(migration, /partition by organization_id\s+order by created_at asc, id asc/);
  assert.match(migration, /alter column customer_code set not null/);
  assert.match(migration, /on public\.customers \(organization_id, customer_code\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /substring\(customer_code from 6\)::bigint/);
  assert.match(migration, /greatest\(3, length\(v_next::text\)\)/);
  assert.match(migration, /customer_code_is_assigned_by_database/);
  assert.match(migration, /customer_code_immutable/);
});

test("all customer-facing call sites use the persisted code", () => {
  assert.match(pilotData, /customer_code/);
  assert.match(pilotData, /customerCode: customer\.customer_code/);
  assert.match(customer360, /code: customer\.customer_code/);
  assert.match(customer360Component, /overview\.code/);
  assert.match(search, /ilike\("customer_code", pattern\)/);
  assert.match(customerDatabase, /customer\.customerCode/);
  assert.match(exportsSource, /row\.customer_code/);
  assert.match(exportsSource, /customer\.get\(s\(r\.customer_id\)\)\?\.customer_code/);
  assert.match(invoiceWorkspace, /customerCodeMap/);
  assert.match(invoiceStudio, /CUST-001/);
});

test("application source no longer synthesizes a CUS code from UUIDs", () => {
  for (const source of [pilotData, customer360, customer360Component, search, customerDatabase, exportsSource, invoiceWorkspace, invoiceStudio]) {
    assert.doesNotMatch(source, /CUS-\$\{/);
    assert.doesNotMatch(source, /CUS-1234/);
  }
});

test("full gate wires migration, SQL/RLS, concurrency and populated-upgrade regressions", () => {
  assert.match(gates, /20261022110000_customer_codes\.sql/);
  assert.match(gates, /20261022110000_test_customer_code\.sql/);
  assert.match(gates, /customer_code\/rls_smoke\.sql/);
  assert.match(gates, /run_customer_code_concurrency\.sh/);
  assert.match(gates, /customer_code_populated_upgrade\.sh/);
});
