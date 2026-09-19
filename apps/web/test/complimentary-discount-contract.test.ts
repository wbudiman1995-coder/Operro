import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(path.resolve(process.cwd(), "../../supabase/migrations/20260919110000_complimentary_next_booking.sql"), "utf8");
const bookingAction = fs.readFileSync(path.resolve(process.cwd(), "src/app/bookings/actions.ts"), "utf8");
const invoiceAction = fs.readFileSync(path.resolve(process.cwd(), "src/app/pilot-actions.ts"), "utf8");

test("only one active next-booking offer can exist per customer", () => {
  assert.match(migration, /unique index uq_customer_next_discounts_active[\s\S]*where status='active'/);
  assert.match(migration, /update public\.customer_next_discounts set status='revoked'[\s\S]*status='active'/);
});

test("offer assignment validates the three HomePaw service scopes", () => {
  assert.match(migration, /array\['basic_grooming','styling','other'\]/);
  assert.match(migration, /v_type not in \('percent','fixed'\)/);
  assert.match(migration, /v_type='percent' and v_value>100/);
});

test("consumption locks the booking and offer and writes an immutable line snapshot", () => {
  const consume = migration.slice(migration.indexOf("function app.consume_customer_next_discount"));
  assert.match(consume, /where organization_id=v_org and id=p_booking[\s\S]*for update/);
  assert.match(consume, /status='active'[\s\S]*for update/);
  assert.match(consume, /'lineDiscounts',v_lines/);
  assert.match(consume, /status='consumed',consumed_at=now\(\),consumed_booking_id=p_booking/);
});

test("booking consumes only after confirmation and recurring copies lose the offer snapshot", () => {
  const confirmAt = bookingAction.indexOf('rpc("transition_booking_status"');
  const consumeAt = bookingAction.indexOf('rpc("consume_customer_next_discount"');
  assert.ok(confirmAt >= 0 && consumeAt > confirmAt);
  assert.match(migration, /coalesce\(new\.recurrence_sequence,1\)>1[\s\S]*metadata-'complimentary_next_discount'/);
});

test("invoice order and frozen invoice lines receive the snapshotted amount", () => {
  assert.match(invoiceAction, /complimentary_next_discount/);
  assert.match(invoiceAction, /discount_amount: line\.discount/);
  assert.match(invoiceAction, /line_total: line\.gross - line\.discount/);
});
