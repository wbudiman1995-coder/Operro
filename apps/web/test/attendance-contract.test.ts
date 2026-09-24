import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260922140000_attendance_tracking.sql"), "utf8");
const actions = fs.readFileSync(path.join(root, "apps/web/src/app/pilot-actions.ts"), "utf8");
const checkin = fs.readFileSync(path.join(root, "apps/web/src/components/attendance-checkin-form.tsx"), "utf8");
const page = fs.readFileSync(path.join(root, "apps/web/src/app/attendance/page.tsx"), "utf8");
const payroll = fs.readFileSync(path.join(root, "apps/web/src/app/payroll/page.tsx"), "utf8");

test("attendance is tenant isolated and RPC writes stay authenticated", () => {
  assert.match(migration, /enable row level security/);
  assert.match(migration, /organization_id=app\.fn_active_organization\(\)/);
  assert.match(migration, /revoke all on function app\.record_attendance_checkin[\s\S]*from public/);
  assert.match(migration, /grant execute on function app\.record_attendance_checkin[\s\S]*to authenticated/);
});

test("check-in requires the assigned groomer, linked photo and valid GPS", () => {
  assert.match(migration, /attendance_not_assigned/);
  assert.match(migration, /attachment_links[\s\S]*subject_type='booking'[\s\S]*subject_id=p_booking/);
  assert.match(migration, /attendance_location_required/);
  assert.match(checkin, /navigator\.geolocation/);
  assert.match(checkin, /compressPhoto/);
  assert.match(actions, /GPS wajib diaktifkan sebelum check-in/);
});

test("server classifies lateness and payroll can audit exceptions", () => {
  assert.match(migration, /v_checked timestamptz:=now\(\)/);
  assert.match(migration, /lateGraceMinutes/);
  assert.match(migration, /'on_time','late','missing_photo'/);
  assert.match(migration, /waive_attendance_lateness/);
  assert.match(migration, /materialize_missing_attendance/);
  assert.match(page, /Sebelumnya/);
  assert.match(page, /Berikutnya/);
  assert.match(payroll, /Periksa kehadiran/);
});
