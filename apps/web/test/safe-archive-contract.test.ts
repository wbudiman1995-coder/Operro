import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT=path.join(__dirname,"../../..");
const migration=fs.readFileSync(path.join(ROOT,"supabase/migrations/20260922130000_safe_booking_archive.sql"),"utf8");
const form=fs.readFileSync(path.join(ROOT,"apps/web/src/components/booking-edit-form.tsx"),"utf8");

test("archive supports explicit current, future and whole-series scopes",()=>{
  assert.match(migration,/p_scope not in \('current','future','all'\)/);
  assert.match(migration,/recurrence_sequence>=v_anchor\.recurrence_sequence/);
  assert.match(form,/seriesArchivableFuture/); assert.match(form,/seriesArchivableAll/);
});
test("archive refuses financial records and cleans linked visit rows",()=>{
  assert.match(migration,/linked_financial_record/);
  assert.match(migration,/update public\.grooming_job_pet_services[\s\S]*deleted_at=v_now/);
  assert.match(migration,/update public\.grooming_job_pets set deleted_at=v_now/);
  assert.match(migration,/update public\.booking_resources set is_active=false/);
});
test("archive reconciles both reserved and consumed package effects",()=>{
  assert.match(migration,/r\.status='consumed'[\s\S]*reverse_package_reservation/);
  assert.match(migration,/r\.status='reserved'[\s\S]*status='released'/);
  assert.match(migration,/package_reservations_reconciled/);
});
