import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOKING_SELECT_ALL,
  BOOKING_SELECT_FILTERED,
  deriveAssignedResourceIds,
} from "../src/lib/schedule";

const ANA = "018f3e10-7b1a-7c11-8c2a-9a4de6e41701";
const BUDI = "018f3e10-7b1a-7c11-8c2a-9a4de6e41702";
const OTHER_BRANCH = "018f3e10-7b1a-7c11-8c2a-9a4de6e41799";

const BRANCH_RESOURCES: ReadonlySet<string> = new Set([ANA, BUDI]);

const NO_SELECTION: string[] = [];

/**
 * `booking_resources` rows are retained when a booking is canceled or marked no-show —
 * `tg_bookings_release_resources` flips `is_active` to false rather than deleting them.
 * A released row is therefore readable and must not place a booking under a groomer.
 */
const released = (resourceId: string) => ({ resource_id: resourceId, is_active: false });
const active = (resourceId: string) => ({ resource_id: resourceId, is_active: true });

// ---------- required behaviour 1: an inactive assignment must not match a selection ----------

test("an inactive assignment does not make a booking match a selected groomer", () => {
  const resourceIds = deriveAssignedResourceIds([released(ANA)], [], BRANCH_RESOURCES, [ANA]);
  assert.deepEqual(resourceIds, []);
});

test("an inactive assignment does not match even when another groomer is active on the booking", () => {
  // Selecting Ana must not surface a booking whose only Ana assignment was released.
  const resourceIds = deriveAssignedResourceIds([released(ANA), active(BUDI)], [], BRANCH_RESOURCES, [ANA]);
  assert.deepEqual(resourceIds, []);
});

// ---------- required behaviour 2: an inactive assignment must not enter resourceIds ----------

test("an inactive assignment is absent from resourceIds in an unfiltered read", () => {
  const resourceIds = deriveAssignedResourceIds([released(ANA), active(BUDI)], [], BRANCH_RESOURCES, NO_SELECTION);
  assert.deepEqual(resourceIds, [BUDI]);
  assert.equal(resourceIds.includes(ANA), false);
});

test("a missing, null, or non-boolean active flag is treated as released", () => {
  for (const assignment of [
    { resource_id: ANA },
    { resource_id: ANA, is_active: null },
    { resource_id: ANA, is_active: "true" },
    { resource_id: ANA, is_active: 1 },
  ]) {
    assert.deepEqual(deriveAssignedResourceIds([assignment], [], BRANCH_RESOURCES, NO_SELECTION), [], JSON.stringify(assignment));
  }
});

test("malformed assignment rows are ignored rather than throwing", () => {
  assert.deepEqual(deriveAssignedResourceIds([null, undefined, 42, "x", {}], [], BRANCH_RESOURCES, NO_SELECTION), []);
});

// ---------- required behaviour 3: active assignments still work ----------

test("active assignments still place a booking under their groomer", () => {
  assert.deepEqual(deriveAssignedResourceIds([active(ANA)], [], BRANCH_RESOURCES, NO_SELECTION), [ANA]);
  assert.deepEqual(deriveAssignedResourceIds([active(ANA)], [], BRANCH_RESOURCES, [ANA]), [ANA]);
});

test("an active assignment for two groomers yields both columns", () => {
  const resourceIds = deriveAssignedResourceIds([active(ANA), active(BUDI)], [], BRANCH_RESOURCES, NO_SELECTION);
  assert.equal(resourceIds.length, 2);
  assert.ok(resourceIds.includes(ANA) && resourceIds.includes(BUDI));
});

test("a selection narrows active assignments to the selected groomers only", () => {
  assert.deepEqual(deriveAssignedResourceIds([active(ANA), active(BUDI)], [], BRANCH_RESOURCES, [BUDI]), [BUDI]);
});

// ---------- required behaviour 4: unassigned bookings stay visible ----------

test("an unassigned booking yields no columns but is not discarded", () => {
  // The loader keeps the booking and renders it with an empty resourceIds array; only the
  // query shape decides visibility, which the select-shape tests below cover.
  assert.deepEqual(deriveAssignedResourceIds([], [], BRANCH_RESOURCES, NO_SELECTION), []);
});

test("the unfiltered select omits !inner so unassigned bookings survive the join", () => {
  assert.equal(BOOKING_SELECT_ALL.includes("booking_resources!inner"), false);
  assert.ok(BOOKING_SELECT_ALL.includes("booking_resources(resource_id,is_active)"));
});

test("the filtered select uses !inner so the groomer restriction reaches the parent rows", () => {
  assert.ok(BOOKING_SELECT_FILTERED.includes("booking_resources!inner(resource_id,is_active)"));
});

test("both selects request is_active, since the derivation depends on it", () => {
  for (const select of [BOOKING_SELECT_ALL, BOOKING_SELECT_FILTERED]) {
    assert.ok(select.includes("is_active"), "select must request is_active");
  }
});

// ---------- multi-pet assigned-resource behaviour is preserved ----------

test("per-pet assigned resources still contribute columns", () => {
  // grooming_job_pets.assigned_resource_id has no active flag; it is a separate
  // authoritative assignment and must keep working for multi-pet bookings.
  assert.deepEqual(deriveAssignedResourceIds([], [ANA, BUDI], BRANCH_RESOURCES, NO_SELECTION).sort(), [ANA, BUDI].sort());
});

test("a per-pet assignment survives alongside a released booking-level assignment", () => {
  const resourceIds = deriveAssignedResourceIds([released(BUDI)], [ANA], BRANCH_RESOURCES, NO_SELECTION);
  assert.deepEqual(resourceIds, [ANA]);
});

test("null per-pet assignments are skipped without collapsing the rest", () => {
  assert.deepEqual(deriveAssignedResourceIds([], [null, ANA, null], BRANCH_RESOURCES, NO_SELECTION), [ANA]);
});

test("a resource appearing as both an active assignment and a pet assignment is not duplicated", () => {
  assert.deepEqual(deriveAssignedResourceIds([active(ANA)], [ANA], BRANCH_RESOURCES, NO_SELECTION), [ANA]);
});

// ---------- branch scoping still applies ----------

test("a resource outside the active branch is excluded even when actively assigned", () => {
  assert.deepEqual(deriveAssignedResourceIds([active(OTHER_BRANCH)], [OTHER_BRANCH], BRANCH_RESOURCES, NO_SELECTION), []);
});
