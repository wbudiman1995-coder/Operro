import assert from "node:assert/strict";
import test from "node:test";

import {
  CANCELLABLE_STATUSES,
  RESCHEDULABLE_STATUSES,
  TERMINAL_STATUSES,
  classifyDatabaseError,
  executeReschedule,
  isCancellable,
  isFulfillmentMode,
  isReschedulable,
  parseClockMinutes,
  parseRescheduleInput,
  planAssignmentSync,
  type CompensatableStep,
  type MutationFailure,
  type RecoveryOutcome,
  type RescheduleRunnerDeps,
  type StepOutcome,
} from "../src/lib/booking-mutations";

const JAKARTA = "Asia/Jakarta";
const ANA = "018f3e10-7b1a-7c11-8c2a-9a4de6e41701";
const BUDI = "018f3e10-7b1a-7c11-8c2a-9a4de6e41702";
const OUTSIDER = "018f3e10-7b1a-7c11-8c2a-9a4de6e41799";
const PET_A = "018f3e10-7b1a-7c11-8c2a-9a4de6e41801";
const PET_B = "018f3e10-7b1a-7c11-8c2a-9a4de6e41802";
const FOREIGN_PET = "018f3e10-7b1a-7c11-8c2a-9a4de6e41899";

const CONTEXT = {
  timeZone: JAKARTA,
  branchResourceIds: new Set([ANA, BUDI]),
  bookingPetIds: new Set([PET_A, PET_B]),
  status: "confirmed",
};

// Correction 3: every pet must resolve to an explicit assignment, so the shared default
// input now carries a complete map. Tests that exercise a specific gap build their own.
function input(overrides: Partial<Parameters<typeof parseRescheduleInput>[0]> = {}) {
  return {
    dateISO: "2026-08-02",
    startTime: "09:00",
    endTime: "10:30",
    fulfillmentMode: "home",
    notes: "Pagar samping",
    petAssignments: new Map<string, string>([[PET_A, ANA], [PET_B, BUDI]]),
    ...overrides,
  };
}

// ---------- status gates (requirement 5) ----------

test("reschedulable statuses exclude in_progress and every terminal status", () => {
  assert.deepEqual([...RESCHEDULABLE_STATUSES], ["draft", "requested", "confirmed"]);
  assert.equal(isReschedulable("in_progress"), false);
  for (const status of TERMINAL_STATUSES) assert.equal(isReschedulable(status), false);
});

test("cancellable statuses include in_progress but no terminal status", () => {
  // Deliberately different from the reschedule gate: app.transition_booking_status accepts
  // in_progress -> canceled, so hiding cancel there would contradict the frozen machine.
  assert.deepEqual([...CANCELLABLE_STATUSES], ["draft", "requested", "confirmed", "in_progress"]);
  assert.equal(isCancellable("in_progress"), true);
  for (const status of TERMINAL_STATUSES) assert.equal(isCancellable(status), false);
});

test("rescheduling a terminal or in-progress booking is rejected by the parser", () => {
  for (const status of ["completed", "canceled", "no_show", "in_progress"]) {
    const result = parseRescheduleInput(input(), { ...CONTEXT, status });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, `status_not_reschedulable:${status}`);
  }
});

test("an unknown status is rejected rather than allowed through", () => {
  const result = parseRescheduleInput(input(), { ...CONTEXT, status: "something_new" });
  assert.equal(result.ok, false);
});

// ---------- branch-timezone parsing across a UTC date boundary (requirement 4) ----------

test("wall-clock input is interpreted in the branch timezone", () => {
  const result = parseRescheduleInput(input({ startTime: "09:00", endTime: "10:30" }), CONTEXT);
  assert.ok(result.ok);
  if (!result.ok) return;
  // 09:00 Jakarta on 2026-08-02 is 02:00Z the same day.
  assert.equal(result.value.startsAt, "2026-08-02T02:00:00.000Z");
  assert.equal(result.value.endsAt, "2026-08-02T03:30:00.000Z");
});

test("a late branch-local time lands on the previous UTC calendar day", () => {
  // 00:30 Jakarta on 2026-08-03 is 17:30Z on 2026-08-02. Parsing in UTC would put this
  // booking on the wrong day entirely.
  const result = parseRescheduleInput(input({ dateISO: "2026-08-03", startTime: "00:30", endTime: "02:00" }), CONTEXT);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.startsAt, "2026-08-02T17:30:00.000Z");
  assert.match(result.value.startsAt, /^2026-08-02/);
});

test("the same wall clock in a negative-offset branch resolves to a different instant", () => {
  const jakarta = parseRescheduleInput(input(), CONTEXT);
  const la = parseRescheduleInput(input(), { ...CONTEXT, timeZone: "America/Los_Angeles" });
  assert.ok(jakarta.ok && la.ok);
  if (!jakarta.ok || !la.ok) return;
  assert.notEqual(jakarta.value.startsAt, la.value.startsAt);
  assert.equal(la.value.startsAt, "2026-08-02T16:00:00.000Z");
});

// ---------- time validation ----------

test("requires ends_at strictly after starts_at", () => {
  for (const [start, end] of [["10:00", "10:00"], ["10:00", "09:00"]]) {
    const result = parseRescheduleInput(input({ startTime: start, endTime: end }), CONTEXT);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "end_before_start");
  }
});

test("rejects malformed dates and times", () => {
  assert.equal(parseRescheduleInput(input({ dateISO: "2026-02-30" }), CONTEXT).ok, false);
  assert.equal(parseRescheduleInput(input({ dateISO: "02/08/2026" }), CONTEXT).ok, false);
  assert.equal(parseRescheduleInput(input({ startTime: "25:00" }), CONTEXT).ok, false);
  assert.equal(parseRescheduleInput(input({ startTime: "9:00" }), CONTEXT).ok, false);
  assert.equal(parseRescheduleInput(input({ endTime: "" }), CONTEXT).ok, false);
});

test("parseClockMinutes accepts only zero-padded 24-hour values", () => {
  assert.equal(parseClockMinutes("00:00"), 0);
  assert.equal(parseClockMinutes("23:59"), 1439);
  assert.equal(parseClockMinutes("24:00"), null);
  assert.equal(parseClockMinutes("12:60"), null);
  assert.equal(parseClockMinutes(null), null);
});

test("fulfillment mode is restricted to the schema's enum", () => {
  assert.equal(isFulfillmentMode("home"), true);
  assert.equal(isFulfillmentMode("in_store"), true);
  assert.equal(isFulfillmentMode("pickup_delivery"), true);
  assert.equal(isFulfillmentMode("teleport"), false);
  assert.equal(parseRescheduleInput(input({ fulfillmentMode: "teleport" }), CONTEXT).ok, false);
});

test("over-long notes are rejected", () => {
  assert.equal(parseRescheduleInput(input({ notes: "x".repeat(2001) }), CONTEXT).ok, false);
});

test("blank notes normalize to null rather than an empty string", () => {
  const result = parseRescheduleInput(input({ notes: "   " }), CONTEXT);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value.notes, null);
});

// ---------- identifier trust (requirements 1, 2, 8) ----------

test("a pet id not on this booking is rejected", () => {
  // Stands in for the cross-organization and cross-booking cases: the server builds
  // bookingPetIds from the booking it loaded, so a foreign pet can never be in the set.
  // Per-entry validation runs before the completeness check, so this is caught even though
  // PET_A and PET_B are then left without an assignment.
  const result = parseRescheduleInput(input({ petAssignments: new Map([[FOREIGN_PET, ANA]]) }), CONTEXT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "pet_not_on_booking");
});

test("a resource outside the booking's branch is rejected", () => {
  const result = parseRescheduleInput(input({ petAssignments: new Map([[PET_A, OUTSIDER], [PET_B, BUDI]]) }), CONTEXT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "resource_not_available_in_branch");
});

test("an empty accessible-resource set rejects every assignment", () => {
  // The shape of the inaccessible-branch case: the server loads no resources for a branch
  // the membership cannot reach, so nothing can be assigned.
  const result = parseRescheduleInput(input({ petAssignments: new Map([[PET_A, ANA], [PET_B, BUDI]]) }), {
    ...CONTEXT,
    branchResourceIds: new Set(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "resource_not_available_in_branch");
});

test("multi-pet bookings keep independent groomers", () => {
  const result = parseRescheduleInput(input({ petAssignments: new Map([[PET_A, ANA], [PET_B, BUDI]]) }), CONTEXT);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.petAssignments.get(PET_A), ANA);
  assert.equal(result.value.petAssignments.get(PET_B), BUDI);
  assert.equal(result.value.petAssignments.size, 2);
});

test("two pets may share one groomer", () => {
  const result = parseRescheduleInput(input({ petAssignments: new Map([[PET_A, ANA], [PET_B, ANA]]) }), CONTEXT);
  assert.ok(result.ok);
  if (result.ok) assert.equal(new Set(result.value.petAssignments.values()).size, 1);
});

// ---------- Correction 3: no pet may be silently left without a groomer ----------

test("a pet entirely absent from the submitted map is rejected, not silently kept as-is", () => {
  const result = parseRescheduleInput(input({ petAssignments: new Map([[PET_A, ANA]]) }), CONTEXT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_groomer_assignment");
});

test("a pet present with an empty string selection is rejected, not treated as no-op", () => {
  // This is the exact v1 bug: the browser's disabled placeholder value ("") reaching the
  // server and being silently coerced into "no change". The server-side check is
  // independent of the client's `required` attribute, which a scripted submit could skip.
  const result = parseRescheduleInput(input({ petAssignments: new Map([[PET_A, ANA], [PET_B, ""]]) }), CONTEXT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_groomer_assignment");
});

test("a pet present with a non-string selection is rejected", () => {
  const result = parseRescheduleInput(
    input({ petAssignments: new Map([[PET_A, ANA], [PET_B, undefined as unknown as string]]) }),
    CONTEXT,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_groomer_assignment");
});

test("a booking with a single pet still requires that pet's assignment", () => {
  const singlePetContext = { ...CONTEXT, bookingPetIds: new Set([PET_A]) };
  const missing = parseRescheduleInput(input({ petAssignments: new Map() }), singlePetContext);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "missing_groomer_assignment");
  const complete = parseRescheduleInput(input({ petAssignments: new Map([[PET_A, ANA]]) }), singlePetContext);
  assert.ok(complete.ok);
});

test("a booking with no pets requires no assignment and succeeds with an empty map", () => {
  const noPetContext = { ...CONTEXT, bookingPetIds: new Set<string>() };
  const result = parseRescheduleInput(input({ petAssignments: new Map() }), noPetContext);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value.petAssignments.size, 0);
});

// ---------- assignment sync planning (requirement 9) ----------

test("an unchanged assignment set only refreshes the occupied window", () => {
  const plan = planAssignmentSync([ANA], [], [ANA]);
  assert.deepEqual(plan, { keep: [ANA], activate: [], deactivate: [] });
});

test("reassigning deactivates the old resource and activates the new one", () => {
  const plan = planAssignmentSync([ANA], [], [BUDI]);
  assert.deepEqual(plan.deactivate, [ANA]);
  assert.deepEqual(plan.activate, [BUDI]);
  assert.deepEqual(plan.keep, []);
});

test("a previously released row is reactivated rather than inserted again", () => {
  // booking_resources is keyed (booking_id, resource_id) and rows are never deleted, so
  // reusing a resource must upsert. The plan puts it in activate, not keep.
  const plan = planAssignmentSync([BUDI], [ANA], [ANA, BUDI]);
  assert.deepEqual(plan.keep, [BUDI]);
  assert.deepEqual(plan.activate, [ANA]);
  assert.deepEqual(plan.deactivate, []);
});

test("an inactive row not in the desired set is never activated accidentally", () => {
  const plan = planAssignmentSync([ANA], [BUDI], [ANA]);
  assert.equal(plan.activate.includes(BUDI), false);
  assert.equal(plan.keep.includes(BUDI), false);
  assert.deepEqual(plan.deactivate, []);
});

test("dropping every assignment deactivates all active rows and activates none", () => {
  const plan = planAssignmentSync([ANA, BUDI], [], []);
  assert.deepEqual(plan.activate, []);
  assert.equal(plan.deactivate.length, 2);
});

// ---------- database error classification (requirement 6) ----------

test("the exclusion violation is recognised as a slot conflict", () => {
  assert.equal(classifyDatabaseError({ code: "23P01", message: "conflicting key value violates exclusion constraint" }), "slot_conflict");
  assert.equal(classifyDatabaseError({ code: null, message: 'violates exclusion constraint "ex_booking_resources_no_overlap"' }), "slot_conflict");
});

test("authorization, transition, and not-found failures are distinguished", () => {
  assert.equal(classifyDatabaseError({ code: "42501", message: "new row violates row-level security policy" }), "not_authorized");
  assert.equal(classifyDatabaseError({ code: null, message: "not_authorized" }), "not_authorized");
  assert.equal(classifyDatabaseError({ code: null, message: "invalid_transition:confirmed->completed" }), "invalid_transition");
  assert.equal(classifyDatabaseError({ code: null, message: "booking_not_open_for_assembly:completed" }), "invalid_transition");
  assert.equal(classifyDatabaseError({ code: null, message: "booking_not_found" }), "not_found");
});

test("anything unrecognised is unexpected, never optimistically allowed", () => {
  assert.equal(classifyDatabaseError({ code: "08006", message: "connection failure" }), "unexpected");
  assert.equal(classifyDatabaseError(null), "unexpected");
  assert.equal(classifyDatabaseError({}), "unexpected");
});

// ---------- orchestration and compensation engine (requirements 7, plus Corrections 1 & 2) ----------

interface Recorder {
  calls: string[];
  compensated: string[];
}

/** Builds a step that always succeeds and records both its run and its compensation. */
function okStep(recorder: Recorder, name: string, overrides: Partial<CompensatableStep> = {}): CompensatableStep {
  return {
    name,
    async run(): Promise<StepOutcome> {
      recorder.calls.push(`run:${name}`);
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      recorder.calls.push(`compensate:${name}`);
      recorder.compensated.push(name);
      return { ok: true };
    },
    ...overrides,
  };
}

function baseDeps(recorder: Recorder, overrides: Partial<RescheduleRunnerDeps> = {}): RescheduleRunnerDeps {
  return {
    async checkBlackouts() {
      recorder.calls.push("checkBlackouts");
      return { blockedResourceId: null, error: null };
    },
    async recheckStatus() {
      recorder.calls.push("recheckStatus");
      return { status: "confirmed", error: null };
    },
    logUnexpected(scope) {
      recorder.calls.push(`logUnexpected:${scope}`);
    },
    ...overrides,
  };
}

function run(deps: RescheduleRunnerDeps, steps: readonly CompensatableStep[]) {
  return executeReschedule(deps, { targetResourceIds: [ANA], startsAt: "2026-08-02T02:00:00.000Z", endsAt: "2026-08-02T03:30:00.000Z", steps });
}

test("the happy path runs every step in order with no compensation", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const steps = [okStep(recorder, "booking_row"), okStep(recorder, "resource_a"), okStep(recorder, "pet_a")];
  const outcome = await run(baseDeps(recorder), steps);
  assert.deepEqual(outcome, { status: "ok" });
  assert.deepEqual(recorder.calls, ["checkBlackouts", "run:booking_row", "recheckStatus", "run:resource_a", "run:pet_a"]);
  assert.deepEqual(recorder.compensated, []);
});

test("a blocking blackout stops before any step runs", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const deps = baseDeps(recorder, {
    async checkBlackouts() {
      recorder.calls.push("checkBlackouts");
      return { blockedResourceId: ANA, error: null };
    },
  });
  const outcome = await run(deps, [okStep(recorder, "booking_row")]);
  assert.deepEqual(outcome, { status: "blackout", resourceId: ANA });
  assert.deepEqual(recorder.calls, ["checkBlackouts"]);
});

test("a blackout probe failure is unexpected and writes nothing", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const deps = baseDeps(recorder, {
    async checkBlackouts() {
      recorder.calls.push("checkBlackouts");
      return { blockedResourceId: null, error: { code: "08006", message: "down" } };
    },
  });
  const outcome = await run(deps, [okStep(recorder, "booking_row")]);
  assert.deepEqual(outcome, { status: "unexpected" });
  assert.equal(recorder.calls.includes("run:booking_row"), false);
});

test("a failure on a later step compensates every already-applied step in reverse order", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const failing: CompensatableStep = {
    name: "pet_a",
    async run(): Promise<StepOutcome> {
      recorder.calls.push("run:pet_a");
      return { ok: false, stale: false, error: { code: "23P01", message: "exclusion" } };
    },
    async compensate() {
      return { ok: true };
    },
  };
  const steps = [okStep(recorder, "booking_row"), okStep(recorder, "resource_a"), failing];
  const outcome = await run(baseDeps(recorder), steps);
  assert.deepEqual(outcome, { status: "slot_conflict" });
  // resource_a applied after booking_row, so it must be compensated first.
  assert.deepEqual(recorder.compensated, ["resource_a", "booking_row"]);
});

test("a step failing with stale:true is reported as not_found, and still triggers compensation", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const stale: CompensatableStep = {
    name: "resource_a",
    async run(): Promise<StepOutcome> {
      return { ok: false, stale: true };
    },
    async compensate() {
      return { ok: true };
    },
  };
  const outcome = await run(baseDeps(recorder), [okStep(recorder, "booking_row"), stale]);
  assert.deepEqual(outcome, { status: "not_found" });
  assert.deepEqual(recorder.compensated, ["booking_row"]);
});

test("a step whose zero-row write matched is never treated as success (Correction 2)", async () => {
  // Same case as above, phrased from the concurrency-guard angle: a write whose WHERE
  // clause matched nothing because the row moved between read and write must never let
  // executeReschedule proceed to the next step.
  const recorder: Recorder = { calls: [], compensated: [] };
  const staleBookingRow: CompensatableStep = {
    name: "booking_row",
    async run(): Promise<StepOutcome> {
      recorder.calls.push("run:booking_row");
      return { ok: false, stale: true };
    },
    async compensate() {
      return { ok: true };
    },
  };
  const outcome = await run(baseDeps(recorder), [staleBookingRow, okStep(recorder, "resource_a")]);
  assert.deepEqual(outcome, { status: "not_found" });
  assert.equal(recorder.calls.includes("run:resource_a"), false, "no later step may run after a stale write");
});

test("when compensation itself fails, the outcome is partially_applied, never a false success", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const failingCompensation: CompensatableStep = {
    name: "resource_a",
    async run(): Promise<StepOutcome> {
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      recorder.calls.push("compensate:resource_a");
      return { ok: false, stale: false, error: { code: "08006", message: "connection lost" } };
    },
  };
  const failingPet: CompensatableStep = {
    name: "pet_a",
    async run(): Promise<StepOutcome> {
      return { ok: false, stale: false, error: { code: "23P01", message: "exclusion" } };
    },
    async compensate() {
      return { ok: true };
    },
  };
  const outcome = await run(baseDeps(recorder), [okStep(recorder, "booking_row"), failingCompensation, failingPet]);
  assert.deepEqual(outcome, { status: "partially_applied" });
  assert.ok(recorder.calls.some((c) => c.startsWith("logUnexpected:reschedule_compensation_failed")));
});

test("an uncompensatable step (null original assignment) forces partially_applied even though every other step reverses cleanly", async () => {
  // Mirrors buildPetStep's real compensate() contract: a pet whose original resource was
  // null cannot be restored through the frozen RPC, so compensate reports a hard failure.
  const recorder: Recorder = { calls: [], compensated: [] };
  const uncompensatablePet: CompensatableStep = {
    name: "pet_a",
    async run(): Promise<StepOutcome> {
      recorder.calls.push("run:pet_a");
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      return { ok: false, stale: false, error: null };
    },
  };
  const failingLast: CompensatableStep = {
    name: "pet_b",
    async run(): Promise<StepOutcome> {
      return { ok: false, stale: false, error: { code: "23P01", message: "exclusion" } };
    },
    async compensate() {
      return { ok: true };
    },
  };
  const outcome = await run(baseDeps(recorder), [okStep(recorder, "booking_row"), uncompensatablePet, failingLast]);
  assert.deepEqual(outcome, { status: "partially_applied" });
});

test("compensation continues through every applied step even after one compensation fails", async () => {
  // Best-effort: a single failed reversal must not stop the rest of the rollback.
  const recorder: Recorder = { calls: [], compensated: [] };
  const failingMiddleCompensation: CompensatableStep = {
    name: "resource_a",
    async run(): Promise<StepOutcome> {
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      recorder.calls.push("compensate:resource_a");
      return { ok: false, stale: false, error: { code: "08006", message: "down" } };
    },
  };
  const failingLast: CompensatableStep = {
    name: "pet_a",
    async run(): Promise<StepOutcome> {
      return { ok: false, stale: false, error: { code: "23P01", message: "exclusion" } };
    },
    async compensate() {
      return { ok: true };
    },
  };
  const steps = [okStep(recorder, "booking_row"), failingMiddleCompensation, failingLast];
  await run(baseDeps(recorder), steps);
  // Even though resource_a's compensation failed, booking_row's compensation must still run.
  assert.ok(recorder.calls.includes("compensate:booking_row"));
});

test("a failed first-step write (the booking row itself) needs no compensation, since nothing else applied", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const failingFirst: CompensatableStep = {
    name: "booking_row",
    async run(): Promise<StepOutcome> {
      return { ok: false, stale: false, error: { code: "42501", message: "row-level security" } };
    },
    async compensate() {
      recorder.calls.push("compensate:booking_row");
      return { ok: true };
    },
  };
  const outcome = await run(baseDeps(recorder), [failingFirst, okStep(recorder, "resource_a")]);
  assert.deepEqual(outcome, { status: "not_authorized" });
  assert.equal(recorder.calls.includes("compensate:booking_row"), false);
});

test("a single-step reschedule (no resource or pet changes) never calls recheckStatus's result against a later step", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const outcome = await run(baseDeps(recorder), [okStep(recorder, "booking_row")]);
  assert.deepEqual(outcome, { status: "ok" });
  assert.deepEqual(recorder.calls, ["checkBlackouts", "run:booking_row", "recheckStatus"]);
});

// ---------- Correction 2: mid-sequence status recheck ----------

test("a status recheck that reveals a concurrent invalid transition compensates and reports invalid_transition", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const deps = baseDeps(recorder, {
    async recheckStatus() {
      recorder.calls.push("recheckStatus");
      // Another operator canceled the booking between our write and this re-read.
      return { status: "canceled", error: null };
    },
  });
  const steps = [okStep(recorder, "booking_row"), okStep(recorder, "resource_a")];
  const outcome = await run(deps, steps);
  assert.deepEqual(outcome, { status: "invalid_transition" });
  assert.deepEqual(recorder.compensated, ["booking_row"]);
  assert.equal(recorder.calls.includes("run:resource_a"), false, "no further step may run once the recheck fails");
});

test("v4 correction 2: a status recheck error stops the sequence, compensates the booking row, and reports unexpected once compensation is verified", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const deps = baseDeps(recorder, {
    async recheckStatus() {
      recorder.calls.push("recheckStatus");
      return { status: null, error: { code: "08006", message: "timeout" } };
    },
  });
  const outcome = await run(deps, [okStep(recorder, "booking_row"), okStep(recorder, "resource_a")]);
  // Never success after an unsuccessful recheck, and never a guess: only the already-applied
  // booking-row step is compensated, and no later resource/pet step ever runs.
  assert.deepEqual(outcome, { status: "unexpected" });
  assert.deepEqual(recorder.compensated, ["booking_row"]);
  assert.equal(recorder.calls.includes("run:resource_a"), false, "no further step may run once the recheck fails");
  assert.ok(recorder.calls.some((c) => c.startsWith("logUnexpected:reschedule_status_recheck_failed")));
});

test("v4 correction 2: a missing row on recheck (status and error both null) is treated the same as a recheck error", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const deps = baseDeps(recorder, {
    async recheckStatus() {
      recorder.calls.push("recheckStatus");
      // The booking is no longer visible under this scope at all, e.g. concurrently
      // soft-deleted — a third distinct symptom of "cannot vouch for the status", not a
      // status value to reason about.
      return { status: null, error: null };
    },
  });
  const outcome = await run(deps, [okStep(recorder, "booking_row"), okStep(recorder, "resource_a")]);
  assert.deepEqual(outcome, { status: "unexpected" });
  assert.deepEqual(recorder.compensated, ["booking_row"]);
  assert.equal(recorder.calls.includes("run:resource_a"), false);
  assert.ok(recorder.calls.some((c) => c.startsWith("logUnexpected:reschedule_status_recheck_missing_row")));
});

test("v4 correction 2: when the booking-row compensation after a failed recheck cannot itself be verified, the outcome is partially_applied, never unexpected", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const uncompensatableBookingRow: CompensatableStep = {
    name: "booking_row",
    async run(): Promise<StepOutcome> {
      recorder.calls.push("run:booking_row");
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      recorder.calls.push("compensate:booking_row");
      return { ok: false, stale: false, error: { code: "08006", message: "down" } };
    },
  };
  const deps = baseDeps(recorder, {
    async recheckStatus() {
      recorder.calls.push("recheckStatus");
      return { status: null, error: { code: "08006", message: "timeout" } };
    },
  });
  const outcome = await run(deps, [uncompensatableBookingRow, okStep(recorder, "resource_a")]);
  assert.deepEqual(outcome, { status: "partially_applied" });
  assert.equal(recorder.calls.includes("run:resource_a"), false);
});

test("a recheck reporting a still-reschedulable status lets the sequence continue", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const deps = baseDeps(recorder, {
    async recheckStatus() {
      return { status: "draft", error: null };
    },
  });
  const outcome = await run(deps, [okStep(recorder, "booking_row"), okStep(recorder, "resource_a")]);
  assert.deepEqual(outcome, { status: "ok" });
});

test("a compensation failure during the recheck's rollback is also reported as partially_applied", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const uncompensatableBookingRow: CompensatableStep = {
    name: "booking_row",
    async run(): Promise<StepOutcome> {
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      return { ok: false, stale: false, error: { code: "08006", message: "down" } };
    },
  };
  const deps = baseDeps(recorder, {
    async recheckStatus() {
      return { status: "canceled", error: null };
    },
  });
  const outcome = await run(deps, [uncompensatableBookingRow]);
  assert.deepEqual(outcome, { status: "partially_applied" });
});

test("pet reassignment steps are simply absent from the sequence when nothing changed, rather than run as no-ops", async () => {
  // executeReschedule has no special case for "no pet changes" — the caller (the server
  // action) is responsible for not constructing a pet step when planAssignmentSync and the
  // parsed assignments show nothing changed. This test documents that contract: an empty
  // steps array beyond the booking row is valid and produces no extra calls.
  const recorder: Recorder = { calls: [], compensated: [] };
  const outcome = await run(baseDeps(recorder), [okStep(recorder, "booking_row")]);
  assert.deepEqual(outcome, { status: "ok" });
  assert.equal(recorder.calls.filter((c) => c.startsWith("run:")).length, 1);
});

// ---------- v3 correction 1: exception safety across the compensation engine ----------

test("a second pet's RPC throwing after the first pet changed compensates the first pet, the resource, and the booking row", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const throwingSecondPet: CompensatableStep = {
    name: "pet_b",
    async run(): Promise<StepOutcome> {
      recorder.calls.push("run:pet_b");
      throw new Error("network dropped mid-write");
    },
    async compensate() {
      return { ok: true };
    },
  };
  const steps = [okStep(recorder, "booking_row"), okStep(recorder, "resource_a"), okStep(recorder, "pet_a"), throwingSecondPet];
  const outcome = await run(baseDeps(recorder), steps);
  assert.deepEqual(outcome, { status: "partially_applied" });
  // pet_a applied most recently among the *verified* steps, so it is unwound first.
  assert.deepEqual(recorder.compensated, ["pet_a", "resource_a", "booking_row"]);
  assert.ok(recorder.calls.some((c) => c.startsWith("logUnexpected:reschedule_step_threw:pet_b")));
});

test("a resource mutation that throws with an uncertain commit state is reported as partially_applied even when it did not apply", async () => {
  // recoverFromUncertainRun re-reads authoritatively and confirms the write never
  // committed — but the earlier steps still need best-effort reversal, and this specific
  // step's own ambiguity must never be silently upgraded to a clean outcome.
  const recorder: Recorder = { calls: [], compensated: [] };
  let recovered = false;
  const uncertainResource: CompensatableStep = {
    name: "resource_a",
    async run(): Promise<StepOutcome> {
      throw new Error("connection reset before response");
    },
    async compensate() {
      return { ok: true };
    },
    async recoverFromUncertainRun(): Promise<RecoveryOutcome> {
      recovered = true;
      return { applied: true, restored: false };
    },
  };
  const outcome = await run(baseDeps(recorder), [okStep(recorder, "booking_row"), uncertainResource]);
  assert.deepEqual(outcome, { status: "partially_applied" });
  assert.equal(recovered, true);
  // The booking row was fully applied and must still be unwound as best-effort.
  assert.deepEqual(recorder.compensated, ["booking_row"]);
});

test("a compensation that throws still lets the remaining compensations execute", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const throwingCompensation: CompensatableStep = {
    name: "resource_a",
    async run(): Promise<StepOutcome> {
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      recorder.calls.push("compensate:resource_a");
      throw new Error("compensation write failed to parse");
    },
  };
  const failingLast: CompensatableStep = {
    name: "pet_a",
    async run(): Promise<StepOutcome> {
      return { ok: false, stale: false, error: { code: "23P01", message: "exclusion" } };
    },
    async compensate() {
      return { ok: true };
    },
  };
  const steps = [okStep(recorder, "booking_row"), throwingCompensation, failingLast];
  const outcome = await run(baseDeps(recorder), steps);
  // resource_a's compensation throwing means full reversal cannot be verified.
  assert.deepEqual(outcome, { status: "partially_applied" });
  // booking_row's compensation must still run despite resource_a's compensate() throwing.
  assert.ok(recorder.calls.includes("compensate:booking_row"));
  assert.ok(recorder.calls.some((c) => c.startsWith("logUnexpected:reschedule_compensation_threw:resource_a")));
});

test("v4 correction 2: a status recheck that throws after the booking-row mutation stops the sequence and compensates it, rather than letting the sequence continue", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const deps = baseDeps(recorder, {
    async recheckStatus(): Promise<{ status: string | null; error: MutationFailure | null }> {
      recorder.calls.push("recheckStatus");
      throw new Error("recheck request timed out");
    },
  });
  const outcome = await run(deps, [okStep(recorder, "booking_row"), okStep(recorder, "resource_a")]);
  // A thrown recheck means this module can no longer vouch for the booking's status at
  // all — never treated as "log and carry on". The booking-row write is compensated and,
  // once that compensation is verified, the outcome is the generic unexpected feedback —
  // never a bare "ok", and no resource/pet step ever runs.
  assert.deepEqual(outcome, { status: "unexpected" });
  assert.deepEqual(recorder.compensated, ["booking_row"]);
  assert.ok(recorder.calls.some((c) => c.startsWith("logUnexpected:reschedule_status_recheck_threw")));
  assert.equal(recorder.calls.includes("run:resource_a"), false, "no further step may run once the recheck throws");
});

test("an ambiguous currently-failing step whose own recovery also throws is reported as partially_applied, not guessed", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const doublyUncertain: CompensatableStep = {
    name: "resource_a",
    async run(): Promise<StepOutcome> {
      throw new Error("connection reset before response");
    },
    async compensate() {
      return { ok: true };
    },
    async recoverFromUncertainRun(): Promise<RecoveryOutcome> {
      throw new Error("recovery read also failed");
    },
  };
  const outcome = await run(baseDeps(recorder), [okStep(recorder, "booking_row"), doublyUncertain]);
  assert.deepEqual(outcome, { status: "partially_applied" });
  assert.ok(recorder.calls.some((c) => c.startsWith("logUnexpected:reschedule_step_threw:resource_a")));
  assert.ok(recorder.calls.some((c) => c.startsWith("logUnexpected:reschedule_step_recovery_threw:resource_a")));
  // Earlier steps still get a best-effort reversal even though resource_a's own fate is unknown.
  assert.deepEqual(recorder.compensated, ["booking_row"]);
});

test("full, verified restoration of every earlier step still reports the original classified error, not ok or unexpected", async () => {
  const recorder: Recorder = { calls: [], compensated: [] };
  const notAuthorized: CompensatableStep = {
    name: "pet_b",
    async run(): Promise<StepOutcome> {
      return { ok: false, stale: false, error: { code: "42501", message: "new row violates row-level security policy" } };
    },
    async compensate() {
      return { ok: true };
    },
  };
  const outcome = await run(baseDeps(recorder), [okStep(recorder, "booking_row"), okStep(recorder, "resource_a"), notAuthorized]);
  // Both earlier steps compensate cleanly and verifiably, yet the reported outcome must
  // still be the failing step's own classified category, never softened to "ok" and never
  // widened to "unexpected" just because the rollback itself succeeded.
  assert.deepEqual(outcome, { status: "not_authorized" });
  assert.deepEqual(recorder.compensated, ["resource_a", "booking_row"]);
});
