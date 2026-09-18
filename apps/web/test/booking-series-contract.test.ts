import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260918140000_booking_series_engine.sql"), "utf8");

test("series creation is tenant and permission scoped", () => {
  assert.match(migration, /fn_active_organization\(\)/);
  assert.match(migration, /has_permission\('booking\.create'\)/);
  assert.match(migration, /assert_tenant_authorized\(v_org, 'scheduling', 'booking\.create', v_template\.branch_id\)/);
});

test("series children preserve immutable service and location snapshots", () => {
  for (const column of ["service_name_snapshot", "price_snapshot", "address_snapshot", "travel_fee", "travel_minutes_snapshot", "service_area_matched"]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
});

test("resource collisions are explicit and support skip or atomic stop", () => {
  assert.match(migration, /p_conflict_mode not in \('skip','stop'\)/);
  assert.match(migration, /exception when exclusion_violation/);
  assert.match(migration, /if p_conflict_mode = 'stop' then raise/);
  assert.match(migration, /skipped_sequences/);
});

test("series materializes independent pet, service, and resource rows", () => {
  assert.match(migration, /insert into public\.grooming_job_pets/);
  assert.match(migration, /insert into public\.grooming_job_pet_services/);
  assert.match(migration, /insert into public\.booking_resources/);
});
