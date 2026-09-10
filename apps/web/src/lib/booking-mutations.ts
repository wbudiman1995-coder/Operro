/**
 * Function index:
 * - RESCHEDULABLE_STATUSES / CANCELLABLE_STATUSES: frozen state-machine gates.
 * - isReschedulable / isCancellable: status guards.
 * - parseRescheduleInput: validates untrusted form input against server-loaded facts.
 * - planAssignmentSync: derives the add/keep/deactivate sets for booking_resources.
 * - classifyDatabaseError: maps a database failure to a user-facing category.
 * - executeReschedule: orchestrates the bounded, multi-step mutation with full
 *   snapshot-and-compensation and optimistic-concurrency guards.
 *
 * WHY THIS IS NOT TRANSACTIONAL. A reschedule can touch three kinds of rows: `bookings`
 * (starts_at/ends_at/fulfillment_mode/notes), `booking_resources` (`during` and the
 * assigned resource set, one row per resource), and per-pet assignments applied through
 * the frozen `app.assembly_assign_pet_resource` RPC. The frozen schema has no
 * rescheduling RPC, and PostgREST gives one statement per request, so none of these
 * writes can share a transaction from the client. The occupancy guarantee still comes
 * from the database: `ex_booking_resources_no_overlap` is a GiST exclusion constraint
 * over (organization_id, resource_id, during) where (is_active and is_exclusive), so a
 * double-booking is rejected as `23P01` no matter how many callers race.
 *
 * What this module adds is bounded damage control, generalised to an arbitrary number of
 * writes: every write is expressed as a `CompensatableStep` that snapshots what it needs
 * to undo itself, and `executeReschedule` runs the steps in order, compensating every
 * already-applied step in reverse the instant one step fails. Two things are true about
 * this even after the fix:
 *   1. Compensation is a best-effort *reversal*, not atomicity — a compensating write can
 *      itself fail (e.g. because of a further concurrent status change), and this module
 *      reports that case explicitly (`partially_applied`) rather than reporting success.
 *   2. Full race-freedom across two independent HTTP requests is impossible without a
 *      transactional RPC. What IS achieved: every write and every compensating write is
 *      verified by its actual affected-row count, so a write that silently matched zero
 *      rows (because a concurrent request already changed the row) is treated as a
 *      failure, never as success, and never triggers a false "reschedule succeeded".
 *
 * `booking_resources.during` has no synchronising trigger — the only trigger on booking
 * status is `tg_bookings_release_resources`, which flips `is_active` only — so `during`
 * must be rewritten explicitly here. Verified in migration 20260721000500.
 *
 * EXCEPTION SAFETY (v3). Everything above assumes a step's `run()`/`compensate()` always
 * RESOLVES, to either `{ ok: true }` or a typed failure. That assumption does not hold —
 * a Supabase call can also THROW (a dropped connection, a response that failed to parse,
 * etc.), and when it does mid-write, the step's actual database effect is unknown: the
 * write may have committed on the server before the throw happened client-side. Neither
 * `executeReschedule` nor `compensateApplied` may let such a throw propagate uncaught,
 * because that would abandon whatever was already applied without attempting reversal.
 * Both are exception-safe throughout: `compensateApplied` catches a throwing
 * `compensate()` and keeps compensating the remaining applied steps; `executeReschedule`
 * catches a throwing `step.run()` and a throwing `recheckStatus()`. A throwing `run()` is
 * additionally routed through `handleUncertainStep`, which uses the step's optional
 * `recoverFromUncertainRun` to authoritatively re-read and, where possible, restore the
 * step's own row — reporting `partially_applied` whenever that cannot be verified, rather
 * than ever guessing.
 *
 * OWNERSHIP-SAFE RECOVERY (v4 correction 1). `recoverFromUncertainRun` re-reads a row this
 * module does not fully control, and none of the tables it touches carry a per-request
 * ownership token — only a generic `updated_at`. A freshly reread `updated_at` therefore
 * proves nothing about who produced the row's current state; it only lets a *subsequent*
 * write guard against racing a *third* writer. Concretely: the row's current state can
 * prove the write definitely did NOT apply (the complete state, `updated_at` included,
 * still equals the pre-run snapshot) — nothing else is provable. Any deviation, including
 * one that happens to match this step's own intended target values, is consistent with
 * either "this step's write committed" or "an unrelated concurrent write landed", and the
 * two are indistinguishable from the row alone. Recovery therefore never attempts to
 * mutate a row it cannot prove untouched; a deviation is reported as `{ applied: true,
 * restored: false }` (ambiguous, unresolved) rather than guessed at, exactly like a
 * verified-applied-but-unrestored write. This is why a concurrent cancellation's release
 * of a resource, or a concurrent terminal booking-status transition, is never undone by
 * recovery — the deviation it produces is, by construction, treated the same as recovery's
 * own uncertain write would be.
 *
 * STOP ON FAILED AUTHORITATIVE RECHECK (v4 correction 2). Once the booking-row step (index
 * 0) has applied, a failure to authoritatively confirm the booking's status — the recheck
 * throwing, resolving with a typed error, or resolving with no row at all — halts the
 * sequence immediately. No resource or pet step is allowed to run against a status this
 * module can no longer vouch for. Only the booking-row step is compensated; the outcome is
 * `unexpected` when that compensation is verified and `partially_applied` when it is not.
 * `executeReschedule` never falls through to `{ status: "ok" }` after an unsuccessful
 * recheck.
 */
import { isValidDateISO, zonedDateTimeToUtc } from "@/lib/timezone";

/** Statuses a booking may be rescheduled from. `in_progress` is deliberately excluded. */
export const RESCHEDULABLE_STATUSES = ["draft", "requested", "confirmed"] as const;

/**
 * Statuses `app.transition_booking_status` accepts a cancel from (migration
 * 20260721001300, lines 1208-1218). `in_progress` IS cancellable even though it is not
 * reschedulable, so the two gates are deliberately different.
 */
export const CANCELLABLE_STATUSES = ["draft", "requested", "confirmed", "in_progress"] as const;

export const TERMINAL_STATUSES = ["completed", "canceled", "no_show"] as const;

export function isReschedulable(status: string): boolean {
  return (RESCHEDULABLE_STATUSES as readonly string[]).includes(status);
}

export function isCancellable(status: string): boolean {
  return (CANCELLABLE_STATUSES as readonly string[]).includes(status);
}

export const FULFILLMENT_MODES = ["home", "in_store", "pickup_delivery"] as const;
export type FulfillmentModeValue = (typeof FULFILLMENT_MODES)[number];

export function isFulfillmentMode(value: unknown): value is FulfillmentModeValue {
  return typeof value === "string" && (FULFILLMENT_MODES as readonly string[]).includes(value);
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MAX_NOTES_LENGTH = 2000;

export function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export interface RescheduleRawInput {
  dateISO: unknown;
  startTime: unknown;
  endTime: unknown;
  fulfillmentMode: unknown;
  notes: unknown;
  /**
   * grooming_job_pet_id -> resource_id chosen in the form. Correction 3: this map MUST
   * carry an entry for every pet on the booking, and every entry MUST be a non-empty
   * string. The caller (the server action) is responsible for reading every pet's form
   * field into this map even when the browser sent an empty string, rather than omitting
   * empty selections — omission is exactly the bug this type's contract now forbids.
   */
  petAssignments: ReadonlyMap<string, string>;
}

export interface RescheduleContext {
  /** Time zone of the booking's own branch, loaded server-side. */
  timeZone: string;
  /** Active, accessible staff resources of the booking's branch, loaded server-side. */
  branchResourceIds: ReadonlySet<string>;
  /** grooming_job_pet_id values that actually belong to this booking. */
  bookingPetIds: ReadonlySet<string>;
  status: string;
}

export interface RescheduleParsed {
  startsAt: string;
  endsAt: string;
  fulfillmentMode: FulfillmentModeValue;
  notes: string | null;
  /** One explicit, validated resource id per pet on the booking. Never partial. */
  petAssignments: Map<string, string>;
}

export type ParseFailure = { ok: false; reason: string };
export type ParseSuccess<T> = { ok: true; value: T };
export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/**
 * Validates untrusted reschedule input. Every identifier is checked against a set that
 * was loaded server-side for this booking, so a browser-supplied pet or resource id from
 * another booking, branch, or organization is rejected rather than trusted.
 *
 * Correction 3 (empty groomer submission): a booking with N pets must resolve to exactly
 * N validated assignments. A pet id absent from `raw.petAssignments`, or present with an
 * empty string, is rejected with `missing_groomer_assignment` rather than silently
 * falling back to whatever resource the pet already had — there is no implicit "keep
 * current groomer" path left in this function. An id present in the map that does not
 * belong to this booking is rejected first (`pet_not_on_booking`), and a non-empty value
 * that is not an active branch resource is rejected as `resource_not_available_in_branch`.
 */
export function parseRescheduleInput(raw: RescheduleRawInput, context: RescheduleContext): ParseResult<RescheduleParsed> {
  if (!isReschedulable(context.status)) {
    return { ok: false, reason: `status_not_reschedulable:${context.status}` };
  }
  if (!isValidDateISO(raw.dateISO)) return { ok: false, reason: "invalid_date" };
  const startMinutes = parseClockMinutes(raw.startTime);
  const endMinutes = parseClockMinutes(raw.endTime);
  if (startMinutes === null) return { ok: false, reason: "invalid_start_time" };
  if (endMinutes === null) return { ok: false, reason: "invalid_end_time" };
  if (endMinutes <= startMinutes) return { ok: false, reason: "end_before_start" };
  if (!isFulfillmentMode(raw.fulfillmentMode)) return { ok: false, reason: "invalid_fulfillment_mode" };

  const notesValue = raw.notes === null || raw.notes === undefined ? "" : String(raw.notes);
  if (notesValue.length > MAX_NOTES_LENGTH) return { ok: false, reason: "notes_too_long" };

  const petAssignments = new Map<string, string>();
  for (const [jobPetId, resourceId] of raw.petAssignments) {
    if (!context.bookingPetIds.has(jobPetId)) return { ok: false, reason: "pet_not_on_booking" };
    if (typeof resourceId !== "string" || resourceId.length === 0) return { ok: false, reason: "missing_groomer_assignment" };
    if (!context.branchResourceIds.has(resourceId)) return { ok: false, reason: "resource_not_available_in_branch" };
    petAssignments.set(jobPetId, resourceId);
  }
  for (const jobPetId of context.bookingPetIds) {
    if (!petAssignments.has(jobPetId)) return { ok: false, reason: "missing_groomer_assignment" };
  }

  // Wall-clock input is interpreted in the branch time zone, never the server's.
  const startsAt = zonedDateTimeToUtc(raw.dateISO, startMinutes, context.timeZone);
  const endsAt = zonedDateTimeToUtc(raw.dateISO, endMinutes, context.timeZone);
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, reason: "end_before_start" };

  return {
    ok: true,
    value: {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      fulfillmentMode: raw.fulfillmentMode,
      notes: notesValue.trim().length > 0 ? notesValue.trim() : null,
      petAssignments,
    },
  };
}

export interface AssignmentSyncPlan {
  /** Rows that exist and stay active — only `during` changes. */
  keep: string[];
  /** Resources newly occupied. May already have an inactive row, so upsert. */
  activate: string[];
  /** Rows that must stop occupying the slot. Never deleted; `is_active` goes false. */
  deactivate: string[];
}

/**
 * Derives the booking_resources changes for a new assignment set.
 *
 * Rows are never deleted. `booking_resources` has no `deleted_at` and is audited by
 * `trg_booking_resources_audit`; the frozen release trigger expresses "no longer
 * occupying" as `is_active = false`, and the exclusion constraint only considers active
 * rows, so deactivation both preserves history and frees the slot.
 */
export function planAssignmentSync(
  existingActive: readonly string[],
  existingInactive: readonly string[],
  desired: readonly string[],
): AssignmentSyncPlan {
  const desiredSet = new Set(desired);
  const activeSet = new Set(existingActive);
  const inactiveSet = new Set(existingInactive);
  return {
    keep: [...activeSet].filter((id) => desiredSet.has(id)),
    activate: [...desiredSet].filter((id) => !activeSet.has(id) || inactiveSet.has(id)).filter((id) => !activeSet.has(id)),
    deactivate: [...activeSet].filter((id) => !desiredSet.has(id)),
  };
}

export type DatabaseErrorCategory = "slot_conflict" | "not_authorized" | "invalid_transition" | "not_found" | "unexpected";

/**
 * Maps a database failure to a category. `23P01` is the exclusion violation raised by
 * `ex_booking_resources_no_overlap`; the textual checks catch the same condition when the
 * client surfaces only a message.
 */
export function classifyDatabaseError(error: { code?: string | null; message?: string | null } | null | undefined): DatabaseErrorCategory {
  if (!error) return "unexpected";
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (code === "23P01" || /exclusion|ex_booking_resources_no_overlap|conflicting key value/i.test(message)) return "slot_conflict";
  if (code === "42501" || /not_authorized|permission denied|row-level security/i.test(message)) return "not_authorized";
  if (/invalid_transition|booking_not_open_for_assembly|use_complete_booking_for_completed/i.test(message)) return "invalid_transition";
  if (code === "PGRST116" || /booking_not_found|pet_not_found|no_data_found/i.test(message)) return "not_found";
  return "unexpected";
}

export interface RescheduleOriginal {
  startsAt: string;
  endsAt: string;
  fulfillmentMode: string;
  notes: string | null;
}

export interface MutationFailure {
  code?: string | null;
  message?: string | null;
}

/**
 * The result of running or compensating one step.
 *
 * `stale: true` means the write matched zero rows under its guard predicate — the row was
 * concurrently changed (or deleted, or moved out of the expected status) between when it
 * was read and when this step ran. That is a *failure*, distinct from a database error,
 * and it is never treated as success (Correction 2).
 */
export type StepOutcome = { ok: true } | { ok: false; stale: true } | { ok: false; stale: false; error: MutationFailure | null };

/**
 * The result of `CompensatableStep.recoverFromUncertainRun`, called only when `run()`
 * threw instead of resolving.
 *
 * `{ applied: false }` means the step authoritatively confirmed its write never took
 * effect (the row still reads as it did before `run()` was called) — the step is treated
 * exactly like an ordinary, non-stale failure that never applied.
 *
 * `{ applied: true, restored: true }` means the write DID commit before the throw, and
 * this method verified the restoration of the original state by its own row-count check —
 * equivalent to a normal, verified `compensate()`.
 *
 * `{ applied: true, restored: false }` means the write committed but restoration could
 * not be verified (or is impossible, e.g. no unassign RPC exists). The caller must never
 * report success for this step's mutation.
 */
export type RecoveryOutcome = { applied: false } | { applied: true; restored: boolean };

/**
 * One unit of the reschedule's non-transactional write sequence.
 *
 * `run` performs the write and MUST verify its own affected-row count — a Supabase
 * `.update(...).select(...)` (or `.insert(...).select(...)`) call that returns zero rows
 * is `{ ok: false, stale: true }`, never `{ ok: true }` (Correction 2).
 *
 * `compensate` reverses the effect of a step whose `run` returned `{ ok: true }`. It is
 * only ever invoked, at most once per step, for steps that actually applied — and always
 * in the reverse of application order. It must verify its own affected-row count the same
 * way. A step that cannot possibly be reversed (for example, a pet whose original
 * assignment was null and the frozen RPC has no "unassign" call) must return
 * `{ ok: false, stale: false, error: null }` from `compensate` rather than pretending to
 * succeed — that is exactly the signal `executeReschedule` uses to report
 * `partially_applied` instead of a false success.
 *
 * `recoverFromUncertainRun` is optional and is invoked ONLY when `run()` itself throws
 * (a JS exception, not a resolved `StepOutcome`) — meaning the step's actual database
 * effect is unknown, e.g. a network drop after a write committed but before the response
 * was parsed. Implementations MUST authoritatively re-read the row(s) this step owns
 * rather than guess, and MUST NOT mutate that row unless the re-read proves, via the
 * complete pre-run snapshot (every captured field, including the row's own concurrency
 * column) matching exactly, that the write never applied — report `{ applied: false }`
 * only in that case. Any other observed state — including one that happens to match this
 * step's own intended target values — cannot be attributed to this request over a
 * concurrent one, so it must be reported as `{ applied: true, restored: false }` without
 * attempting any write (v4 correction 1). A step that omits this method, or whose
 * `recoverFromUncertainRun` itself throws, leaves its own outcome permanently unknown —
 * `executeReschedule` treats both as `partially_applied`, regardless of whether the other,
 * already-applied steps were successfully compensated.
 */
export interface CompensatableStep {
  /** Stable identifier for logging and tests. Not shown to the browser. */
  name: string;
  run(): Promise<StepOutcome>;
  compensate(): Promise<StepOutcome>;
  recoverFromUncertainRun?(): Promise<RecoveryOutcome>;
}

export interface RescheduleRunnerDeps {
  /** Best-effort blackout probe. Returns a resource id when the target window is blocked. */
  checkBlackouts(resourceIds: readonly string[], startsAt: string, endsAt: string): Promise<{ blockedResourceId: string | null; error: MutationFailure | null }>;
  /**
   * Authoritative re-read of the booking status, performed right after the booking row's
   * own step (index 0) applies and before any resource/pet steps run. `{ status: null,
   * error: null }` signals a missing row (e.g. the booking is no longer visible under this
   * scope). Per v4 correction 2, `executeReschedule` treats a throw, a resolved `error`,
   * and a missing row identically: all three stop the sequence before any resource or pet
   * step runs, rather than being logged and allowed to fall through.
   */
  recheckStatus(): Promise<{ status: string | null; error: MutationFailure | null }>;
  logUnexpected(scope: string, error: unknown): void;
}

export type RescheduleOutcome =
  | { status: "ok" }
  | { status: "blackout"; resourceId: string }
  | { status: "slot_conflict" }
  | { status: "not_authorized" }
  | { status: "invalid_transition" }
  | { status: "not_found" }
  | { status: "unexpected" }
  /** A step applied but a later step failed AND full compensation could not be verified. */
  | { status: "partially_applied" };

/**
 * Compensates every applied step in reverse order. A step whose `compensate()` THROWS is
 * logged and marked unsuccessful exactly like one that resolves to a failed `StepOutcome`
 * — the throw must never abort the loop, or every step applied before the throwing one
 * would be left uncompensated (v3 correction 1).
 */
async function compensateApplied(applied: readonly CompensatableStep[], deps: RescheduleRunnerDeps): Promise<boolean> {
  let allCompensated = true;
  // Reverse of application order: the most recently applied step is undone first.
  for (let i = applied.length - 1; i >= 0; i--) {
    const step = applied[i];
    try {
      const result = await step.compensate();
      if (!result.ok) {
        allCompensated = false;
        deps.logUnexpected(`reschedule_compensation_failed:${step.name}`, result.stale ? "stale_compensation" : result.error);
      }
    } catch (thrown) {
      allCompensated = false;
      deps.logUnexpected(`reschedule_compensation_threw:${step.name}`, thrown);
    }
    // Best effort: keep compensating the remaining applied steps even after one
    // compensation fails or throws, so as much of the original state as possible is
    // restored.
  }
  return allCompensated;
}

/**
 * Handles a `step.run()` that threw instead of resolving — the step's real database
 * effect is unknown. Attempts authoritative recovery via `step.recoverFromUncertainRun`
 * when the step provides one; otherwise (or if recovery itself throws, or cannot verify
 * restoration) the outcome is unconditionally `partially_applied`, because this module
 * can no longer prove what state the step's own row is in.
 *
 * `applied` never includes the throwing step itself — only the steps that ran (and were
 * row-count-verified) before it. Those are always given a best-effort compensation pass
 * regardless of how the throwing step's own recovery resolves.
 */
async function handleUncertainStep(
  step: CompensatableStep,
  thrown: unknown,
  applied: readonly CompensatableStep[],
  deps: RescheduleRunnerDeps,
): Promise<RescheduleOutcome> {
  deps.logUnexpected(`reschedule_step_threw:${step.name}`, thrown);

  if (!step.recoverFromUncertainRun) {
    await compensateApplied(applied, deps);
    return { status: "partially_applied" };
  }

  let recovery: RecoveryOutcome | null = null;
  try {
    recovery = await step.recoverFromUncertainRun();
  } catch (recoveryError) {
    deps.logUnexpected(`reschedule_step_recovery_threw:${step.name}`, recoveryError);
  }

  if (!recovery || (recovery.applied && !recovery.restored)) {
    // Either recovery itself failed to produce an answer, or it confirmed the write
    // committed but could not verify undoing it. Either way this step's own state is not
    // provably restored, so the overall outcome must be partially_applied no matter how
    // the earlier steps' compensation below turns out.
    await compensateApplied(applied, deps);
    return { status: "partially_applied" };
  }

  // Confirmed either "never applied" or "applied and verifiably restored" — this step is
  // fully accounted for. Only the earlier, already-applied steps still need reversal.
  const compensated = await compensateApplied(applied, deps);
  return compensated ? { status: "unexpected" } : { status: "partially_applied" };
}

/**
 * Runs an ordered, non-transactional sequence of reschedule steps with full
 * snapshot-and-compensation (Correction 1) and a best-effort mid-sequence status
 * recheck (Correction 2).
 *
 * Contract with the caller (the server action that builds `input.steps`): step 0 MUST be
 * the `bookings` row update, guarded by both the expected prior status and an optimistic
 * concurrency token (e.g. `updated_at`); every subsequent step is a `booking_resources`
 * write or a per-pet RPC call, each independently guarded and independently
 * compensatable. This module does not know about Supabase — it only orchestrates the
 * abstract steps — so every DB-specific detail (predicates, `.select()` row-count checks,
 * RPC calls) lives in the concrete `CompensatableStep` implementations the caller
 * constructs.
 */
export async function executeReschedule(
  deps: RescheduleRunnerDeps,
  input: { targetResourceIds: readonly string[]; startsAt: string; endsAt: string; steps: readonly CompensatableStep[] },
): Promise<RescheduleOutcome> {
  // Best-effort pre-check. Not race-free: the frozen schema has no exclusion constraint
  // between blackouts and booking assignments, so a blackout created between this probe
  // and the writes below will not be rejected by the database. No mutation has run yet at
  // this point, so a throw here needs no compensation — just a safe, logged failure.
  let blackout: { blockedResourceId: string | null; error: MutationFailure | null };
  try {
    blackout = await deps.checkBlackouts(input.targetResourceIds, input.startsAt, input.endsAt);
  } catch (thrown) {
    deps.logUnexpected("reschedule_blackout_probe_threw", thrown);
    return { status: "unexpected" };
  }
  if (blackout.error) {
    deps.logUnexpected("reschedule_blackout_probe", blackout.error);
    return { status: "unexpected" };
  }
  if (blackout.blockedResourceId) return { status: "blackout", resourceId: blackout.blockedResourceId };

  const applied: CompensatableStep[] = [];

  for (let index = 0; index < input.steps.length; index++) {
    const step = input.steps[index];

    // A throw here means this step's actual database effect is unknown — unlike a
    // resolved `{ ok: false }`, the step may or may not have already committed its
    // write. `handleUncertainStep` is the only path allowed to decide the outcome from
    // here; falling through to an ordinary generic error without it would risk leaving
    // an uncompensated, unverified mutation in place (v3 correction 1).
    let result: StepOutcome;
    try {
      result = await step.run();
    } catch (thrown) {
      return handleUncertainStep(step, thrown, applied, deps);
    }

    if (!result.ok) {
      const compensated = await compensateApplied(applied, deps);
      if (!compensated) return { status: "partially_applied" };
      if (result.stale) return { status: "not_found" };
      const category = classifyDatabaseError(result.error);
      if (category === "unexpected") deps.logUnexpected(`reschedule_step_failed:${step.name}`, result.error);
      return { status: category === "slot_conflict" ? "slot_conflict" : category };
    }

    applied.push(step);

    if (index === 0) {
      // v4 correction 2: a thrown recheck, a resolved recheck error, and a missing row
      // (recheckStatus resolves `{ status: null, error: null }` when the booking is no
      // longer visible under this scope, e.g. concurrently soft-deleted) are three
      // distinct symptoms of the same underlying fact — this module can no longer
      // authoritatively vouch for the booking's status. Unlike a resolved, non-null
      // status that just happens to be non-reschedulable, none of these three give any
      // status to reason about at all, so they must not be treated as "log and carry
      // on": every one of them stops the sequence outright, before any resource or pet
      // step runs, and only the already-applied booking-row step is compensated.
      let recheck: { status: string | null; error: MutationFailure | null };
      let recheckThrew = false;
      try {
        recheck = await deps.recheckStatus();
      } catch (thrown) {
        deps.logUnexpected("reschedule_status_recheck_threw", thrown);
        recheckThrew = true;
        recheck = { status: null, error: null };
      }

      if (recheckThrew || recheck.error || recheck.status === null) {
        if (!recheckThrew) {
          if (recheck.error) {
            deps.logUnexpected("reschedule_status_recheck_failed", recheck.error);
          } else {
            deps.logUnexpected("reschedule_status_recheck_missing_row", null);
          }
        }
        // Never return success after an unsuccessful status recheck: the booking-row
        // write is guarded compensation-first, and the outcome reflects only whether
        // that compensation itself was verified — resource/pet steps never run.
        const compensated = await compensateApplied(applied, deps);
        return compensated ? { status: "unexpected" } : { status: "partially_applied" };
      }

      if (!isReschedulable(recheck.status)) {
        const compensated = await compensateApplied(applied, deps);
        return compensated ? { status: "invalid_transition" } : { status: "partially_applied" };
      }
    }
  }

  return { status: "ok" };
}
