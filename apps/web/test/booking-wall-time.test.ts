import assert from "node:assert/strict";
import test from "node:test";

import { addWallMinutes, toBranchInstant } from "../src/lib/booking-wall-time";

test("a clicked Jakarta 09:00 calendar slot persists as 09:00 Jakarta", () => {
  assert.equal(toBranchInstant("2026-10-20T09:00", "Asia/Jakarta"), "2026-10-20T02:00:00.000Z");
  assert.equal(toBranchInstant("2026-10-20T09:00", "Asia/Makassar"), "2026-10-20T01:00:00.000Z");
});

test("automatic service duration adds wall-clock minutes across midnight", () => {
  assert.equal(addWallMinutes("2026-10-20T23:30", 60), "2026-10-21T00:30");
});
