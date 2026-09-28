import assert from "node:assert/strict";
import test from "node:test";
import { correctedMembershipExpiry, membershipExpiryDate } from "../src/lib/membership-correction";

test("membership expiry uses the Jakarta day across UTC midnight", () => {
  assert.equal(membershipExpiryDate("2026-12-25T17:15:58.919207+00:00"), "2026-12-26");
  assert.equal(membershipExpiryDate(null), "");
});

test("unchanged expiry day preserves the exact original timestamp", () => {
  const original = "2026-12-25T17:15:58.919207+00:00";
  assert.equal(correctedMembershipExpiry("2026-12-26", original), original);
});

test("explicit new day uses Jakarta end of day; blank deliberately removes expiry", () => {
  assert.equal(correctedMembershipExpiry("2027-01-10", null), "2027-01-10T16:59:59.000Z");
  assert.equal(correctedMembershipExpiry("", "2026-12-25T17:15:58Z"), null);
  assert.throws(() => correctedMembershipExpiry("2026-02-30", null));
});
