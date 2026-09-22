import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260918140000_booking_series_engine.sql"), "utf8");
const controls = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260922110000_booking_series_controls.sql"), "utf8");
const form = fs.readFileSync(path.join(ROOT, "apps/web/src/components/booking-edit-form.tsx"), "utf8");
const actions = fs.readFileSync(path.join(ROOT, "apps/web/src/app/schedule/actions.ts"), "utf8");

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

test("collisions can use a bounded nearby alternative time", () => {
  assert.match(controls, /p_conflict_mode not in \('skip','stop','next_available'\)/);
  assert.match(controls, /for candidate in 1\.\.8 loop/);
  assert.match(controls, /candidate\*interval '30 minutes'/);
  assert.match(controls, /'alternative_minutes',v_alternatives/);
  assert.match(form, /value="next_available"/);
});

test("series cancellation has explicit current, future, and all scopes", () => {
  assert.match(controls, /p_scope not in \('current','future','all'\)/);
  assert.match(controls, /recurrence_sequence>=v_anchor\.recurrence_sequence/);
  assert.match(controls, /perform app\.transition_booking_status\(v_id,'canceled'\)/);
  assert.match(controls, /assert_tenant_authorized\(v_org,'scheduling','booking\.cancel',v_anchor\.branch_id\)/);
  assert.match(form, /name="scope"/);
  assert.match(actions, /cancelBookingSeriesAction/);
});

test("the occurrence materializer cannot be called by browser roles", () => {
  assert.match(controls, /revoke all on function app\.materialize_booking_series_occurrence\(uuid,uuid,integer,interval\) from public,anon,authenticated/);
});
