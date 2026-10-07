import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { auditFieldLabel, computeChangedFields } from "../src/lib/audit-diff";

const root = path.resolve(import.meta.dirname, "../../..");

test("UPDATE reports only the fields whose value actually changed", () => {
  const fields = computeChangedFields("UPDATE", { status: "issued", total: 100 }, { status: "paid", total: 100 });
  assert.deepEqual(fields, ["Status"]);
});

test("uses owner-facing labels and a readable fallback", () => {
  assert.equal(auditFieldLabel("customer_notes"), "Catatan pelanggan");
  assert.equal(auditFieldLabel("display_name"), "Nama pelanggan");
  assert.equal(auditFieldLabel("source"), "Sumber akuisisi");
  assert.equal(auditFieldLabel("external_reference"), "External Reference");
});

test("UPDATE ignores audit metadata even when it changed", () => {
  const fields = computeChangedFields("UPDATE", { status: "issued", updated_at: "t0", updated_by: "actor-a" }, { status: "issued", updated_at: "t1", updated_by: "actor-b" });
  assert.deepEqual(fields, []);
});

test("INSERT and DELETE report no changed fields", () => {
  assert.deepEqual(computeChangedFields("INSERT", {}, { status: "issued" }), []);
  assert.deepEqual(computeChangedFields("DELETE", { status: "issued" }, {}), []);
});

test("customer audit review is capability gated before the RPC is called", () => {
  const customerModel = fs.readFileSync(path.join(root, "apps/web/src/lib/customer-360.ts"), "utf8");
  const customerPage = fs.readFileSync(path.join(root, "apps/web/src/app/customers/[customerId]/page.tsx"), "utf8");
  assert.match(customerModel, /history: "customer\.read"/);
  assert.match(customerPage, /tab === "history" && tabPermitted\s*\? await loadAuditEvents/);
});
