import assert from "node:assert/strict";
import test from "node:test";

import { parseBookingDraft } from "../src/lib/booking-validation";
import { dogSizeFromWeight, resolveServiceForPet } from "../src/lib/pet-sizing";

const ids = {
  branch: "018f3e10-7b1a-7c11-8c2a-9a4de6e41501",
  customer: "018f3e10-7b1a-7c11-8c2a-9a4de6e41502",
  pet: "018f3e10-7b1a-7c11-8c2a-9a4de6e41503",
  resource: "018f3e10-7b1a-7c11-8c2a-9a4de6e41504",
  service: "018f3e10-7b1a-7c11-8c2a-9a4de6e41505",
  customerPackage: "018f3e10-7b1a-7c11-8c2a-9a4de6e41506",
};

const valid = { branchId: ids.branch, customerId: ids.customer, startsAt: "2026-08-03T09:00:00+07:00", endsAt: "2026-08-03T10:00:00+07:00", fulfillmentMode: "home", notes: "  Aman  ", pets: [{ petId: ids.pet, resourceId: ids.resource, serviceIds: [ids.service] }] };

test("weight boundaries and cat pricing use the same bands as the SQL booking snapshot", () => {
  assert.deepEqual([4.99, 5, 9.99, 10, 14.99, 15, 25, 25.01].map(dogSizeFromWeight),
    ["extra_small", "small", "small", "medium", "medium", "large", "large", "extra_large"]);
  const service = { durationMinutes: 60, basePrice: 99000, priceExtraSmall: 99000, priceMedium: 170000, priceCat: 120000, durationMedium: 90, durationCat: 60 };
  assert.deepEqual(resolveServiceForPet(service, { species: "dog", size: "small", weightKg: 12 }), { band: "medium", price: 170000, duration: 90 });
  assert.deepEqual(resolveServiceForPet(service, { species: "cat", size: null, weightKg: 4 }), { band: "cat", price: 120000, duration: 60 });
});

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
