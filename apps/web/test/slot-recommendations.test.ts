import assert from "node:assert/strict";
import test from "node:test";
import { haversineKm, recommendSlots, trafficFactorForMinute } from "../src/lib/slot-recommendations";

test("haversine returns a plausible Jakarta distance", () => {
  const km = haversineKm({ latitude: -6.2, longitude: 106.816 }, { latitude: -6.2146, longitude: 106.8451 });
  assert.ok(km > 3 && km < 5);
});

test("traffic factor is higher in morning and evening peaks", () => {
  assert.equal(trafficFactorForMinute(8 * 60), 1.35);
  assert.equal(trafficFactorForMinute(12 * 60), 1.1);
  assert.equal(trafficFactorForMinute(20 * 60), 1);
});

test("recommends only common free windows for every selected groomer", () => {
  const slots = recommendSlots({
    fromDateISO: "2026-09-21", days: 1, timeZone: "Asia/Jakarta", durationMinutes: 60,
    resourceIds: ["r1", "r2"],
    availability: [
      { resourceId: "r1", dayOfWeek: 1, startMinutes: 8 * 60, endMinutes: 12 * 60 },
      { resourceId: "r2", dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 11 * 60 },
    ],
    occupied: [{ resourceId: "r1", startsAt: "2026-09-21T02:00:00.000Z", endsAt: "2026-09-21T03:00:00.000Z", coordinates: null }],
    destination: null, branchBase: null, now: new Date("2026-09-20T00:00:00.000Z"), limit: 20,
  });
  assert.deepEqual(slots.map((slot) => slot.startTime), ["10:00"]);
});

test("uses the previous stop before branch base for route scoring", () => {
  const slots = recommendSlots({
    fromDateISO: "2026-09-21", days: 1, timeZone: "Asia/Jakarta", durationMinutes: 60,
    resourceIds: ["r1"], availability: [{ resourceId: "r1", dayOfWeek: 1, startMinutes: 10 * 60, endMinutes: 12 * 60 }],
    occupied: [{ resourceId: "r1", startsAt: "2026-09-21T01:00:00.000Z", endsAt: "2026-09-21T02:00:00.000Z", coordinates: { latitude: -6.2, longitude: 106.816 } }],
    destination: { latitude: -6.21, longitude: 106.82 }, branchBase: { latitude: -7, longitude: 107 }, now: new Date("2026-09-20T00:00:00.000Z"), limit: 1,
  });
  assert.equal(slots[0]?.routeOrigin, "previous_stop");
  assert.ok((slots[0]?.travelKm ?? 99) < 2);
});

test("an explicitly selected customer anchor overrides the previous stop", () => {
  const slots = recommendSlots({
    fromDateISO: "2026-09-21", days: 1, timeZone: "Asia/Jakarta", durationMinutes: 60,
    resourceIds: ["r1"], availability: [{ resourceId: "r1", dayOfWeek: 1, startMinutes: 10 * 60, endMinutes: 11 * 60 }],
    occupied: [{ resourceId: "r1", startsAt: "2026-09-21T01:00:00.000Z", endsAt: "2026-09-21T02:00:00.000Z", coordinates: { latitude: -7, longitude: 107 } }],
    destination: { latitude: -6.21, longitude: 106.82 }, branchBase: null, selectedAnchor: { latitude: -6.2, longitude: 106.816 }, now: new Date("2026-09-20T00:00:00.000Z"), limit: 1,
  });
  assert.equal(slots[0]?.routeOrigin, "selected_anchor");
  assert.ok((slots[0]?.travelKm ?? 99) < 2);
});

test("same-city days rank above a groomer day already committed to another city", () => {
  const slots = recommendSlots({
    fromDateISO: "2026-09-21", days: 2, timeZone: "Asia/Jakarta", durationMinutes: 60,
    resourceIds: ["r1"],
    availability: [
      { resourceId: "r1", dayOfWeek: 1, startMinutes: 10 * 60, endMinutes: 11 * 60 },
      { resourceId: "r1", dayOfWeek: 2, startMinutes: 10 * 60, endMinutes: 11 * 60 },
    ],
    occupied: [
      { resourceId: "r1", startsAt: "2026-09-21T01:00:00.000Z", endsAt: "2026-09-21T02:00:00.000Z", coordinates: null, city: "Depok" },
      { resourceId: "r1", startsAt: "2026-09-22T01:00:00.000Z", endsAt: "2026-09-22T02:00:00.000Z", coordinates: null, city: "Jakarta Selatan" },
    ],
    destination: null, destinationCity: "Jakarta Selatan", branchBase: null, now: new Date("2026-09-20T00:00:00.000Z"), limit: 2,
  });
  assert.equal(slots[0]?.dateISO, "2026-09-22");
  assert.equal(slots[0]?.cityCompatible, true);
  assert.equal(slots[1]?.cityCompatible, false);
});
