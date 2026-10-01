import assert from "node:assert/strict";
import test from "node:test";

import { computeChangedFields } from "../src/lib/audit-diff";

test("UPDATE reports only the fields whose value actually changed", () => {
  const fields = computeChangedFields("UPDATE", { status: "issued", total: 100 }, { status: "paid", total: 100 });
  assert.deepEqual(fields, ["status"]);
});

test("UPDATE ignores updated_at even when it changed", () => {
  const fields = computeChangedFields("UPDATE", { status: "issued", updated_at: "t0" }, { status: "issued", updated_at: "t1" });
  assert.deepEqual(fields, []);
});

test("INSERT and DELETE report no changed fields", () => {
  assert.deepEqual(computeChangedFields("INSERT", {}, { status: "issued" }), []);
  assert.deepEqual(computeChangedFields("DELETE", { status: "issued" }, {}), []);
});
