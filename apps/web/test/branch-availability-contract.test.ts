import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260922120000_branch_availability_controls.sql"), "utf8");
const api = fs.readFileSync(path.join(ROOT, "apps/web/src/app/api/availability/slots/route.ts"), "utf8");
const manager = fs.readFileSync(path.join(ROOT, "apps/web/src/components/branch-availability-manager.tsx"), "utf8");

test("branch closure races are rejected from both mutation directions", () => {
  assert.match(migration, /tg_reject_branch_block_booking_overlap/);
  assert.match(migration, /tg_reject_booking_branch_block_overlap/);
  assert.match(migration, /br\.during && tstzrange\(new\.starts_at,new\.ends_at,'\[\)'\)/);
  assert.match(migration, /tstzrange\(x\.starts_at,x\.ends_at,'\[\)'\) && new\.during/);
});

test("availability tables are tenant, branch and capability scoped", () => {
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /organization_id=app\.fn_active_organization\(\)/);
  assert.match(migration, /app\.has_permission\('resource\.manage'\) and app\.has_branch\(branch_id\)/);
});

test("slot recommendations consume closures and dated served-city plans", () => {
  assert.match(api, /from\("branch_availability_blocks"\)/);
  assert.match(api, /from\("branch_served_city_dates"\)/);
  assert.match(api, /servedCities/);
});

test("management UI exposes both branch closures and served-city dates", () => {
  assert.match(manager, /Penutupan seluruh cabang/);
  assert.match(manager, /Kota layanan per tanggal/);
  assert.match(manager, /createBranchBlockAction/);
  assert.match(manager, /createServedCityDateAction/);
});
