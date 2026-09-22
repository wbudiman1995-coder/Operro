import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const actions = fs.readFileSync(path.join(root, "apps/web/src/app/pilot-actions.ts"), "utf8");
const manager = fs.readFileSync(path.join(root, "apps/web/src/components/resource-manager.tsx"), "utf8");
const data = fs.readFileSync(path.join(root, "apps/web/src/lib/pilot-data.ts"), "utf8");
const schedule = fs.readFileSync(path.join(root, "apps/web/src/lib/schedule.ts"), "utf8");

test("groomer profiles carry phone, calendar color and route base coordinates", () => {
  for (const field of ["phone", "calendar_color", "base_location", "latitude", "longitude"]) assert.ok(actions.includes(field));
  assert.match(manager, /MapsCoordinateFields/);
  assert.match(schedule, /calendar_color/);
});

test("groomers can link to memberships, compensation and their filtered schedule", () => {
  assert.match(actions, /membership_id: membershipId/);
  assert.match(actions, /staff_compensation/);
  assert.match(actions, /payroll\.manage/);
  assert.match(manager, /\/schedule\?branch=\$\{resource\.branchId\}&groomer=\$\{resource\.id\}/);
  assert.match(data, /appointmentCount/);
});

test("archiving is a soft delete and refuses future assigned bookings", () => {
  assert.match(actions, /export async function archiveResourceAction/);
  assert.match(actions, /booking_resources/);
  assert.match(actions, /masih memiliki booking aktif mendatang/);
  assert.match(actions, /status: "retired", deleted_at: now/);
  assert.doesNotMatch(actions, /from\("resources"\)\.delete\(/);
});
