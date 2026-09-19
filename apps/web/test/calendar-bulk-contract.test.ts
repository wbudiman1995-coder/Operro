import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { classifyBookingSource } from "../src/lib/schedule";

const ROOT = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260919120000_calendar_bulk_actions.sql"), "utf8");
const actions = fs.readFileSync(path.join(ROOT, "apps/web/src/app/schedule/actions.ts"), "utf8");
const board = fs.readFileSync(path.join(ROOT, "apps/web/src/components/schedule-board.tsx"), "utf8");

test("calendar move is one locked transaction with collision and blackout enforcement", () => {
  assert.match(migration, /create or replace function app\.move_schedule_bookings/);
  assert.match(migration, /order by id for update/);
  assert.match(migration, /set is_active=false/);
  assert.match(migration, /set starts_at=starts_at\+v_delta,ends_at=ends_at\+v_delta/);
  assert.match(migration, /kind='blackout'/);
  assert.match(migration, /set is_active=true/);
  assert.match(migration, /'booking\.schedule_moved'/);
  assert.match(migration, /grant execute on function app\.move_schedule_bookings\(uuid\[\],integer,uuid\) to authenticated/);
});

test("mass cancellation delegates every row to the canonical state machine", () => {
  assert.match(migration, /create or replace function app\.cancel_schedule_bookings/);
  assert.match(migration, /assert_tenant_authorized\(v_org,'scheduling','booking\.cancel'/);
  assert.match(migration, /perform app\.transition_booking_status\(v_row\.id,'canceled'\)/);
  assert.doesNotMatch(migration, /update public\.bookings\s+set status\s*=\s*'canceled'/i);
});

test("server actions call only app-schema bulk RPCs and keep a confirmation token", () => {
  assert.match(actions, /schema\("app"\)\.rpc\("move_schedule_bookings"/);
  assert.match(actions, /schema\("app"\)\.rpc\("cancel_schedule_bookings"/);
  assert.match(actions, /formData\.get\("confirm"\).*"yes"/);
  assert.match(actions, /ids\.length >= 1 && ids\.length <= 50/);
});

test("calendar exposes drag, shift-selection, grouped controls and source badges", () => {
  assert.match(board, /draggable=\{movable\}/);
  assert.match(board, /event\.shiftKey/);
  assert.match(board, /resourceIds\.length <= 1/);
  assert.match(board, /Pilih beberapa/);
  assert.match(board, /bookingIds[\s\S]*selectedIds/);
  assert.match(board, /Paket prabayar/);
  assert.match(board, /Langganan/);
  assert.match(board, /Gratis/);
});

test("source badges prefer membership, then complimentary, then package coverage", () => {
  assert.equal(classifyBookingSource({ source: "membership renewal" }, true), "subscription");
  assert.equal(classifyBookingSource({ booking_source: "complimentary" }, false), "free");
  assert.equal(classifyBookingSource({}, true), "prepaid");
  assert.equal(classifyBookingSource({ source: "walk in" }, false), null);
});
