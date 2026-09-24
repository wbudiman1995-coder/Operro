import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260924100000_complaint_lifecycle.sql"), "utf8");
const grantsMigration = fs.readFileSync(path.join(root, "supabase/migrations/20260924110000_complaint_rpc_only_writes.sql"), "utf8");
const actions = fs.readFileSync(path.join(root, "apps/web/src/app/complaints/actions.ts"), "utf8");
const page = fs.readFileSync(path.join(root, "apps/web/src/app/complaints/page.tsx"), "utf8");
const exporter = fs.readFileSync(path.join(root, "apps/web/src/app/api/complaints/export/route.ts"), "utf8");

test("complaints are tenant and branch isolated with no browser table writes", () => {
  assert.match(migration, /alter table public\.complaints enable row level security/);
  assert.match(migration, /organization_id=app\.fn_active_organization\(\)/);
  assert.match(migration, /app\.has_branch\(branch_id\)/);
  assert.match(migration, /grant select on public\.complaints to authenticated/);
  assert.match(migration, /revoke insert,update,delete on public\.complaints from anon,authenticated/);
  assert.match(grantsMigration, /revoke insert,update,delete on public\.complaints from anon,authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update|delete).*complaints.*authenticated/i);
});

test("creation validates every linked tenant entity", () => {
  assert.match(migration, /booking_mismatch/);
  assert.match(migration, /pet_mismatch/);
  assert.match(migration, /resource_mismatch/);
  assert.match(migration, /b\.customer_id=p_customer/);
  assert.match(migration, /p\.customer_id=p_customer/);
});

test("lifecycle requires resolution notes and writes immutable history", () => {
  assert.match(migration, /invalid_complaint_transition/);
  assert.match(migration, /resolution_notes_required/);
  assert.match(migration, /complaint\.created/);
  assert.match(migration, /complaint\.status_changed/);
  assert.match(migration, /trg_complaints_audit/);
});

test("application exposes recovery, audit, filters and authorized CSV export", () => {
  assert.match(actions, /recoveryAction/);
  assert.match(page, /Audit aktivitas/);
  assert.match(page, /Semua keparahan/);
  assert.match(exporter, /loadCapabilities/);
  assert.match(exporter, /text\/csv/);
  assert.match(exporter, /content-disposition/);
  assert.match(exporter, /\^\[=\+\\-@\]/);
});
