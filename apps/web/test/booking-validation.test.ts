import assert from "node:assert/strict";
import test from "node:test";

import { parseBookingDraft } from "../src/lib/booking-validation";

const ids = {
  branch: "018f3e10-7b1a-7c11-8c2a-9a4de6e41501",
  customer: "018f3e10-7b1a-7c11-8c2a-9a4de6e41502",
  pet: "018f3e10-7b1a-7c11-8c2a-9a4de6e41503",
  resource: "018f3e10-7b1a-7c11-8c2a-9a4de6e41504",
  service: "018f3e10-7b1a-7c11-8c2a-9a4de6e41505",
  customerPackage: "018f3e10-7b1a-7c11-8c2a-9a4de6e41506",
};

const valid = { branchId: ids.branch, customerId: ids.customer, startsAt: "2026-08-03T09:00:00+07:00", endsAt: "2026-08-03T10:00:00+07:00", fulfillmentMode: "home", notes: "  Aman  ", pets: [{ petId: ids.pet, resourceId: ids.resource, serviceIds: [ids.service] }] };

test("accepts and normalizes a valid multi-entity draft", () => {
  const result = parseBookingDraft(valid);
  assert.equal(result.customerNotes, "Aman");
  assert.equal(result.pets.length, 1);
});
test("requires a pet", () => assert.throws(() => parseBookingDraft({ ...valid, pets: [] }), /minimal satu hewan/));
test("requires an end after the start", () => assert.throws(() => parseBookingDraft({ ...valid, endsAt: valid.startsAt }), /setelah waktu mulai/));
test("rejects duplicate pets", () => assert.throws(() => parseBookingDraft({ ...valid, pets: [valid.pets[0], valid.pets[0]] }), /tidak boleh dipilih dua kali/));
test("requires service per pet", () => assert.throws(() => parseBookingDraft({ ...valid, pets: [{ ...valid.pets[0], serviceIds: [] }] }), /minimal satu layanan/));
test("rejects malformed ids", () => assert.throws(() => parseBookingDraft({ ...valid, branchId: "bad" }), /tidak valid/));
test("keeps only package allocations attached to selected services", () => {
  const result = parseBookingDraft({ ...valid, pets: [{ ...valid.pets[0], packageByService: { [ids.service]: ids.customerPackage } }] });
  assert.equal(result.pets[0].packageByService[ids.service], ids.customerPackage);
  assert.throws(() => parseBookingDraft({ ...valid, pets: [{ ...valid.pets[0], packageByService: { [ids.resource]: ids.customerPackage } }] }), /Alokasi paket/);
});
test("validates bounded, unique category discounts", () => {
  const result = parseBookingDraft({ ...valid, categoryDiscounts: [{ category: "Basic Grooming", type: "percent", value: 15 }] });
  assert.equal(result.categoryDiscounts[0].value, 15);
  assert.throws(() => parseBookingDraft({ ...valid, categoryDiscounts: [{ category: "Basic Grooming", type: "percent", value: 101 }] }), /Diskon kategori/);
});
