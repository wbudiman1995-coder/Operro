import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Structural invariant guards.
 *
 * These assert properties of the mutation source itself. They are NOT a substitute for
 * live-database testing and they prove nothing about PostgREST or RLS behaviour. What they
 * do catch is a future edit silently removing an isolation predicate, hard-deleting an
 * audited row, bypassing the controlled cancellation RPC, dropping the exception
 * containment added in Batch 1B v2, or losing the row-count verification the v1 audit
 * flagged as missing — the failure modes that are invisible in a unit test and expensive
 * to discover in production.
 */
const ACTIONS = readFileSync(path.join(process.cwd(), "src/app/schedule/actions.ts"), "utf8");
const MUTATIONS = readFileSync(path.join(process.cwd(), "src/lib/booking-mutations.ts"), "utf8");
const BOOKINGS_PAGE = readFileSync(path.join(process.cwd(), "src/app/bookings/page.tsx"), "utf8");
const SCHEDULE = readFileSync(path.join(process.cwd(), "src/lib/schedule.ts"), "utf8");
// v4 correction 3: the concrete reschedule step builders were extracted out of actions.ts
// into their own dependency-injectable module so they can be exercised against an
// in-memory fake db client (see reschedule-steps.test.ts). Several structural guards
// below that used to slice actions.ts for a specific builder now read this file instead.
const RESCHEDULE_STEPS = readFileSync(path.join(process.cwd(), "src/lib/reschedule-steps.ts"), "utf8");
const MUTATION_SOURCES = `${ACTIONS}\n${RESCHEDULE_STEPS}`;

// ---------- cancellation is delegated and never destructive (requirements 10, 11) ----------

test("cancellation goes through the controlled status RPC", () => {
  assert.ok(ACTIONS.includes('rpc("transition_booking_status"'), "cancel must call app.transition_booking_status");
  assert.ok(ACTIONS.includes('p_to: "canceled"'));
});

test("no mutation hard-deletes a row", () => {
  // booking_resources and resource_availability are both audited. Removal is expressed as
  // is_active = false or deleted_at, never DELETE.
  assert.equal(/\.delete\s*\(/.test(ACTIONS), false, "actions must not call .delete()");
  assert.equal(/\bDELETE\s+FROM\b/i.test(ACTIONS), false);
});

test("a rejected pet reassignment is never silently deleted, only deactivated or restored", () => {
  assert.equal(/\.delete\s*\(/.test(MUTATIONS), false);
});

test("blackout removal is a soft delete", () => {
  assert.ok(ACTIONS.includes("deleted_at: new Date().toISOString()"), "removal must set deleted_at");
  assert.ok(ACTIONS.includes('removeBlackoutAction'));
});

test("package and resource release is not reimplemented in application code", () => {
  // The RPC releases reserved package sessions, and its status write fires
  // trg_bookings_release_resources for occupancy. Doing either here would duplicate or
  // contradict the frozen behaviour.
  assert.equal(ACTIONS.includes("package_reservations"), false, "reservation release belongs to the RPC");
  assert.equal(/status:\s*['"]released['"]/.test(ACTIONS), false);
  assert.equal(ACTIONS.includes("released_at"), false);
});

// ---------- permissions (requirement 3) ----------

test("reschedule requires both the semantic and the RLS-required capability", () => {
  assert.ok(ACTIONS.includes('capabilities["booking.update"]'), "semantic gate");
  assert.ok(ACTIONS.includes('capabilities["booking.create"]'), "frozen bookings UPDATE policy gate");
});

test("cancel requires booking.cancel and the RPC's booking.update", () => {
  assert.ok(ACTIONS.includes('capabilities["booking.cancel"]'));
  const cancelSection = ACTIONS.slice(ACTIONS.indexOf("cancelBookingAction"));
  assert.ok(cancelSection.includes('capabilities["booking.update"]'), "the RPC asserts booking.update");
});

test("blackout mutations require resource.manage", () => {
  assert.ok(ACTIONS.includes('capabilities["resource.manage"]'));
  // Resolved in one shared helper so no blackout action can skip the check.
  assert.equal(ACTIONS.split('capabilities["resource.manage"]').length - 1, 1);
  assert.ok(ACTIONS.includes("resolveBlackoutWorkspace"));
});

test("every mutation reads capabilities rather than trusting the client", () => {
  assert.ok(ACTIONS.includes("loadCapabilities"));
  assert.equal(/formData\.get\(["']can[A-Za-z]+["']\)/.test(ACTIONS), false, "capabilities must never arrive from the form");
});

// ---------- organization and branch isolation (requirements 1, 2) ----------

test("no mutation trusts an organization id from the browser", () => {
  assert.equal(/formData\.get\(["']organizationId["']\)/.test(ACTIONS), false);
  assert.ok(ACTIONS.includes("loadAuthContext"), "organization comes from the verified session");
});

test("branch access is re-resolved server-side for every mutation", () => {
  assert.ok(ACTIONS.includes("loadBranchAccess"));
  assert.ok(ACTIONS.includes("isBranchAccessible"), "a supplied branch id must be checked, not trusted");
});

test("every write is scoped by organization_id", () => {
  // v4: the booking_resources/bookings writes moved into reschedule-steps.ts, so this scans
  // both the server action and the extracted step module.
  const writeCalls = MUTATION_SOURCES.match(/\.from\("(bookings|booking_resources|resource_availability)"\)/g) ?? [];
  assert.ok(writeCalls.length >= 6, "expected several scoped table operations");
  // Count guards rather than parsing: one organization predicate per table operation.
  const orgPredicates = MUTATION_SOURCES.match(/\.eq\("organization_id",\s*(?:ctx\.)?organizationId\)/g) ?? [];
  assert.ok(orgPredicates.length >= writeCalls.length, `expected >= ${writeCalls.length} org predicates, found ${orgPredicates.length}`);
});

test("booking writes are additionally scoped by branch", () => {
  const bookingUpdates = MUTATION_SOURCES.match(/\.from\("bookings"\)\s*\n\s*\.update\(/g) ?? [];
  assert.ok(bookingUpdates.length >= 2, "expected the update and its compensating restore");
  const branchPredicates = MUTATION_SOURCES.match(/\.eq\("branch_id",\s*(?:ctx\.)?branchId\)/g) ?? [];
  assert.ok(branchPredicates.length >= bookingUpdates.length);
});

test("no service-role credential is referenced anywhere in the mutations", () => {
  for (const forbidden of ["SERVICE_ROLE", "service_role", "serviceRole", "SUPABASE_SERVICE"]) {
    assert.equal(ACTIONS.includes(forbidden), false, `must not reference ${forbidden}`);
    assert.equal(MUTATIONS.includes(forbidden), false, `must not reference ${forbidden}`);
  }
});

test("identifiers arriving from the form are shape-validated", () => {
  assert.ok(ACTIONS.includes("UUID_PATTERN.test(bookingId)"));
  assert.ok(ACTIONS.includes("UUID_PATTERN.test(blackoutId)"));
});

// ---------- destructive actions require confirmation ----------

test("cancel and blackout removal require an explicit confirmation token", () => {
  const confirmations = ACTIONS.match(/formData\.get\("confirm"\)\s*\?\?\s*""\)\s*!==\s*"yes"/g) ?? [];
  assert.equal(confirmations.length, 2, "cancel and blackout removal both confirm");
});

// ---------- error disclosure (Correction 4: exception containment) ----------

test("unexpected database detail is logged server-side, not returned to the browser", () => {
  assert.ok(ACTIONS.includes("console.error"));
  assert.ok(ACTIONS.includes("GENERIC_ERROR"));
  // No raw error message is interpolated into a returned string.
  assert.equal(/error:\s*`[^`]*\$\{[^}]*error\.message/.test(ACTIONS), false, "must not leak error.message to the client");
});

test("every exported mutation action wraps its entire body in try/catch", () => {
  const exported = [...ACTIONS.matchAll(/^export async function (\w+Action)\(/gm)].map((m) => m[1]);
  assert.ok(exported.length >= 5, "expected reschedule, cancel, and three blackout actions");
  for (const name of exported) {
    const start = ACTIONS.indexOf(`export async function ${name}(`);
    const next = ACTIONS.indexOf("\nexport async function", start + 1);
    const body = next === -1 ? ACTIONS.slice(start) : ACTIONS.slice(start, next);
    assert.ok(body.includes("try {"), `${name} must wrap its body in try`);
    assert.ok(/} catch \(error\) \{/.test(body), `${name} must catch unexpected throws`);
    assert.ok(/console\.error\(["'][a-z_]+_unexpected["'], error\)/.test(body), `${name} must log the unexpected throw`);
    assert.ok(body.includes("return { error: GENERIC_ERROR, success: null }"), `${name}'s catch must return the generic message, not leak detail`);
  }
});

// ---------- targeted revalidation ----------

test("booking mutations revalidate every affected surface", () => {
  for (const route of ["/schedule", "/bookings", "/dashboard", "/operations"]) {
    assert.ok(ACTIONS.includes(`revalidatePath("${route}")`), `must revalidate ${route}`);
  }
  assert.ok(ACTIONS.includes("revalidatePath(`/customers/${customerId}`)"));
});

// ---------- Correction 1 & 2: compensation engine and optimistic concurrency ----------

test("the reschedule engine snapshots and compensates an arbitrary number of steps, not a fixed two", () => {
  assert.ok(MUTATIONS.includes("interface CompensatableStep"));
  assert.ok(MUTATIONS.includes("run(): Promise<StepOutcome>"));
  assert.ok(MUTATIONS.includes("compensate(): Promise<StepOutcome>"));
  assert.ok(MUTATIONS.includes("async function compensateApplied"));
  // Compensation walks the applied list in reverse.
  assert.ok(/for \(let i = applied\.length - 1; i >= 0; i--\)/.test(MUTATIONS));
});

test("a step failure that cannot be fully compensated is reported as partially_applied, never success", () => {
  assert.ok(MUTATIONS.includes('"partially_applied"'));
  assert.ok(/if \(!compensated\) return \{ status: "partially_applied" \}/.test(MUTATIONS));
});

test("the booking row write is guarded by both status and the optimistic concurrency token", () => {
  // v4: buildBookingRowStep now lives in reschedule-steps.ts.
  const step = RESCHEDULE_STEPS.slice(RESCHEDULE_STEPS.indexOf('name: "booking_row"'), RESCHEDULE_STEPS.indexOf("export function buildDeactivateStep"));
  assert.ok(step.includes('.eq("status", ctx.originalStatus)'), "must guard on the status read at load time");
  assert.ok(step.includes('.eq("updated_at", ctx.originalUpdatedAt)'), "must guard on the concurrency token read at load time");
});

test("every step verifies its own affected-row count rather than trusting an absent error", () => {
  const count =
    (MUTATIONS.match(/data\.length !== 1/g) ?? []).length +
    (ACTIONS.match(/data\.length !== 1/g) ?? []).length +
    (RESCHEDULE_STEPS.match(/data\.length !== 1/g) ?? []).length;
  assert.ok(count >= 8, `expected several independent row-count checks, found ${count}`);
});

test("a pet whose original groomer was null cannot be falsely reported as fully restored", () => {
  const petStep = RESCHEDULE_STEPS.slice(RESCHEDULE_STEPS.indexOf("export function buildPetStep"));
  assert.ok(petStep.includes("if (!originalResourceId)"));
  assert.ok(petStep.includes("{ ok: false, stale: false, error: null }"));
});

test("a newly-activated booking_resources row is deactivated on compensation, never deleted", () => {
  const activateStep = RESCHEDULE_STEPS.slice(RESCHEDULE_STEPS.indexOf("export function buildActivateStep"), RESCHEDULE_STEPS.indexOf("export function buildPetStep"));
  assert.equal(/\.delete\s*\(/.test(activateStep), false);
  assert.ok(activateStep.includes("is_active: false"));
});

test("a mid-sequence status recheck exists and re-validates reschedulability", () => {
  assert.ok(MUTATIONS.includes("recheckStatus"));
  assert.ok(MUTATIONS.includes("isReschedulable(recheck.status)"));
});

// ---------- Correction 3: no empty groomer assignment can be submitted ----------

test("the parser requires a complete, non-empty assignment for every pet on the booking", () => {
  assert.ok(MUTATIONS.includes('"missing_groomer_assignment"'));
  assert.ok(MUTATIONS.includes("for (const jobPetId of context.bookingPetIds)"));
});

test("the server action reads every pet's form field, including an absent or empty one, rather than skipping it", () => {
  const section = ACTIONS.slice(ACTIONS.indexOf("rescheduleBookingAction"), ACTIONS.indexOf("cancelBookingAction"));
  assert.ok(section.includes("for (const pet of detail.pets)"), "every pet must get an entry in the raw map, not only the ones present in formData");
  assert.ok(section.includes('typeof chosen === "string" ? chosen : ""'), "an absent field must become an empty string, not be omitted");
});

// ---------- Correction 5: blackout row-count verification ----------

test("blackout update and removal verify the affected row count before reporting success", () => {
  const update = ACTIONS.slice(ACTIONS.indexOf("export async function updateBlackoutAction"), ACTIONS.indexOf("export async function removeBlackoutAction"));
  const remove = ACTIONS.slice(ACTIONS.indexOf("export async function removeBlackoutAction"));
  for (const [name, section] of [["updateBlackoutAction", update], ["removeBlackoutAction", remove]] as const) {
    assert.ok(section.includes('.select("id")'), `${name} must select the affected row back`);
    assert.ok(section.includes("result.data.length !== 1"), `${name} must check exactly one row was affected`);
    assert.ok(section.includes("STALE_ERROR"), `${name} must report a zero-row result as stale, not success`);
  }
});

// ---------- customer preselection is a hint, not an authorization input (requirement 15) ----------

test("the preselected customer is re-read server-side within the active organization", () => {
  assert.ok(BOOKINGS_PAGE.includes("resolvePreselectedCustomer"));
  assert.ok(BOOKINGS_PAGE.includes('.from("customers")'));
  assert.ok(BOOKINGS_PAGE.includes('.eq("organization_id", organizationId)'));
  assert.ok(BOOKINGS_PAGE.includes("UUID_PATTERN.test(candidate)"));
});

test("an inaccessible preselection opens the wizard normally, exposing no authorization difference", () => {
  // Both the malformed and the not-found paths return undefined; neither throws, redirects,
  // nor renders a distinguishable state, so the parameter cannot be used to probe ids.
  const fn = BOOKINGS_PAGE.slice(BOOKINGS_PAGE.indexOf("async function resolvePreselectedCustomer"), BOOKINGS_PAGE.indexOf("export default"));
  assert.equal((fn.match(/return undefined;/g) ?? []).length, 2);
  assert.equal(fn.includes("notFound"), false);
  assert.equal(fn.includes("redirect"), false);
  assert.equal(fn.includes("throw"), false);
});

// ---------- v3 correction 1: exception safety in the compensation engine ----------

test("a thrown step.run() is never treated as an ordinary generic error — it always routes through handleUncertainStep", () => {
  assert.ok(MUTATIONS.includes("async function handleUncertainStep"));
  const loop = MUTATIONS.slice(MUTATIONS.indexOf("for (let index = 0; index < input.steps.length"), MUTATIONS.indexOf("return { status: \"ok\" };"));
  assert.ok(/try\s*\{\s*result = await step\.run\(\);/.test(loop), "step.run() must be awaited inside a try block");
  assert.ok(loop.includes("return handleUncertainStep(step, thrown, applied, deps);"));
});

test("handleUncertainStep never guesses: no recovery method, a thrown recovery, or an unverified restore all resolve to partially_applied", () => {
  const fn = MUTATIONS.slice(MUTATIONS.indexOf("async function handleUncertainStep"), MUTATIONS.indexOf("export async function executeReschedule"));
  assert.ok(fn.includes("if (!step.recoverFromUncertainRun)"));
  assert.ok(/catch \(recoveryError\)/.test(fn), "a thrown recoverFromUncertainRun must itself be caught");
  assert.ok(fn.includes("recovery.applied && !recovery.restored"));
  assert.equal((fn.match(/"partially_applied"/g) ?? []).length, 3, "every unresolved branch must land on partially_applied");
});

test("compensateApplied catches a throwing compensate() and keeps compensating the remaining applied steps", () => {
  const fn = MUTATIONS.slice(MUTATIONS.indexOf("async function compensateApplied"), MUTATIONS.indexOf("async function handleUncertainStep"));
  assert.ok(fn.includes("try {"));
  assert.ok(/catch \(thrown\) \{/.test(fn));
  // Both the resolved-failure branch and the thrown branch must mark the same failure flag,
  // and neither may return or break out of the loop early.
  assert.equal((fn.match(/allCompensated = false;/g) ?? []).length, 2);
  assert.equal(/\breturn\b/.test(fn.slice(0, fn.indexOf("return allCompensated;"))), false, "no early return before every applied step has had a compensation attempt");
});

test("a thrown status recheck after the booking-row mutation falls back to a neutral result rather than returning early from inside the catch", () => {
  // v4 correction 2: the catch itself still must not return — it normalizes to a neutral
  // recheck result and lets the shared handling below decide. That shared handling now
  // always stops the sequence (compensate + unexpected/partially_applied) for a throw, a
  // resolved error, or a missing row; it never lets a later step run. See the dedicated v4
  // correction 2 test below for that stop-and-compensate behavior.
  const section = MUTATIONS.slice(MUTATIONS.indexOf("if (index === 0)"), MUTATIONS.indexOf("return { status: \"ok\" };"));
  assert.ok(/try\s*\{\s*recheck = await deps\.recheckStatus\(\);/.test(section));
  assert.ok(section.includes("reschedule_status_recheck_threw"));
  const catchBlock = section.slice(section.indexOf("catch (thrown)"), section.indexOf("if (recheck.error)"));
  assert.equal(catchBlock.includes("return"), false, "the catch must not return directly; the shared stop-and-compensate handling runs after it");
});

test("v4 correction 2: a thrown recheck, a resolved recheck error, and a missing row all stop the sequence and compensate before returning, never falling through to run a later step", () => {
  const section = MUTATIONS.slice(MUTATIONS.indexOf("if (index === 0)"), MUTATIONS.indexOf("if (!isReschedulable(recheck.status))"));
  assert.ok(section.includes("recheckThrew || recheck.error || recheck.status === null"), "all three failure modes must share one stop condition");
  assert.ok(section.includes("reschedule_status_recheck_missing_row"), "a missing row must be logged distinctly from a resolved error");
  assert.ok(/await compensateApplied\(applied, deps\)/.test(section));
  assert.ok(/return compensated \? \{ status: "unexpected" \} : \{ status: "partially_applied" \}/.test(section), "verified compensation reports unexpected; unverified reports partially_applied — never ok");
});

test("every concrete resource and pet step builder implements recoverFromUncertainRun for the thrown-run case", () => {
  const buildersSection = RESCHEDULE_STEPS.slice(RESCHEDULE_STEPS.indexOf("export function buildDeactivateStep"));
  assert.equal((buildersSection.match(/async recoverFromUncertainRun\(\): Promise<RecoveryOutcome>/g) ?? []).length, 4, "deactivate, keep, activate, and pet steps must each define it");
});

test("the concrete step builders are extracted into a dedicated, dependency-injectable module rather than inlined in the server action", () => {
  assert.ok(ACTIONS.includes('from "@/lib/reschedule-steps"'), "actions.ts must import the builders, not reimplement them");
  assert.equal(ACTIONS.includes("function buildDeactivateStep"), false, "step builders must not be reinlined in the server action");
  assert.ok(RESCHEDULE_STEPS.includes("export interface RescheduleDbClient"), "the db dependency must be an injectable interface, not the live Supabase client type");
  assert.ok(ACTIONS.includes("as unknown as RescheduleDbClient"), "the server action bridges the real client to the injectable interface at one explicit point");
});

// ---------- v3 correction 3: booking_resources concurrency guards ----------

test("BookingResourceSnapshot captures updated_at alongside resource_id, during, and is_active", () => {
  const snapshot = SCHEDULE.slice(SCHEDULE.indexOf("export interface BookingResourceSnapshot"), SCHEDULE.indexOf("resourceAssignments: BookingResourceSnapshot[]"));
  assert.ok(snapshot.includes("resourceId: string;"));
  assert.ok(snapshot.includes("during: string;"));
  assert.ok(snapshot.includes("isActive: boolean;"));
  assert.ok(snapshot.includes("updatedAt: string;"));
  assert.ok(SCHEDULE.includes("typeof assignment.updated_at === \"string\""), "the loader must not synthesize a snapshot for a row missing its concurrency token");
});

test("every resource step guards its own write on the snapshot's updated_at, and remembers what it wrote so compensation guards on that value, not the stale snapshot", () => {
  const buildersSection = RESCHEDULE_STEPS.slice(RESCHEDULE_STEPS.indexOf("export function buildDeactivateStep"), RESCHEDULE_STEPS.indexOf("export function buildPetStep"));
  const runGuards = buildersSection.match(/\.eq\("updated_at", snapshot\.updatedAt\)/g) ?? [];
  const compensateGuards = buildersSection.match(/\.eq\("updated_at", appliedUpdatedAt \?\? ""\)/g) ?? [];
  assert.ok(runGuards.length >= 3, `expected a run() guard in deactivate/keep/activate, found ${runGuards.length}`);
  assert.ok(compensateGuards.length >= 3, `expected a compensate() guard in deactivate/keep/activate, found ${compensateGuards.length}`);
});

test("v4 correction 1: recoverFromUncertainRun never writes — booking-row, resource, and pet recovery are all pure reads, so an unprovable ownership case can never mutate the row", () => {
  // Under v3, recovery re-read updated_at and then wrote a guarded restore. v4 forbids that:
  // a fresh updated_at proves nothing about which request owns the change, so recovery must
  // only compare the freshly-read state against the original snapshot and never call
  // .update(/.insert( itself. Split on the method name rather than slicing between function
  // boundaries, since booking-row recovery is a separate function from the resource/pet ones.
  const segments = RESCHEDULE_STEPS.split("async recoverFromUncertainRun(): Promise<RecoveryOutcome> {").slice(1);
  assert.equal(segments.length, 5, "booking-row, deactivate, keep, activate, and pet steps must each define recoverFromUncertainRun");
  for (const segment of segments) {
    const closeAt = segment.indexOf("\n  };");
    const body = closeAt === -1 ? segment : segment.slice(0, closeAt);
    assert.equal(/\.update\s*\(/.test(body), false, "recovery must never attempt a restore write");
    assert.equal(/\.insert\s*\(/.test(body), false, "recovery must never attempt an insert");
  }
});

test("buildActivateStep distinguishes a guarded reactivation from a new-row insert, and never upserts over an existing row", () => {
  const activateStep = RESCHEDULE_STEPS.slice(RESCHEDULE_STEPS.indexOf("export function buildActivateStep"), RESCHEDULE_STEPS.indexOf("export function buildPetStep"));
  assert.equal(/\.upsert\s*\(/.test(activateStep), false, "an unguarded upsert could silently overwrite a concurrent assignment");
  assert.ok(activateStep.includes("if (snapshot) {"), "a prior row must take the guarded-update branch");
  assert.ok(activateStep.includes(".insert({ booking_id: ctx.bookingId"), "no prior row must take a genuine insert, never upsert");
});

test("zero or unexpected affected rows are reported as stale, never as a silent success, throughout the resource step builders", () => {
  const buildersSection = RESCHEDULE_STEPS.slice(RESCHEDULE_STEPS.indexOf("export function buildDeactivateStep"), RESCHEDULE_STEPS.indexOf("export function buildPetStep"));
  const staleChecks = buildersSection.match(/if \(!result\.data \|\| result\.data\.length !== 1\) return \{ ok: false, stale: true \};/g) ?? [];
  assert.ok(staleChecks.length >= 5, `expected a stale check after every guarded write, found ${staleChecks.length}`);
});

// ---------- v3 correction 4: blackout conflict detection follows booking_resources.during ----------

test("findConflictingBooking derives the active-assignment window from booking_resources.during, never from bookings.starts_at/ends_at", () => {
  const fn = ACTIONS.slice(ACTIONS.indexOf("async function findConflictingBooking"), ACTIONS.indexOf("export async function createBlackoutAction"));
  assert.ok(fn.includes('.select("booking_id,resource_id,during,is_active,bookings!inner(deleted_at)")'), "only deleted_at may be read off the joined booking");
  assert.ok(fn.includes("deriveActiveAssignmentWindows(rows)"));
  assert.equal(/bookings\.starts_at|bookings\.ends_at|\bstarts_at,\s*ends_at\b/.test(fn), false, "the parent booking's own timing columns must never be read here");
});

test("both blackout-mutation call sites route their conflict check through findConflictingBooking", () => {
  const calls = ACTIONS.match(/await findConflictingBooking\(/g) ?? [];
  assert.ok(calls.length >= 2, `expected createBlackoutAction and updateBlackoutAction to both call findConflictingBooking, found ${calls.length}`);
});
