/**
 * Concrete, database-backed `CompensatableStep` builders for `executeReschedule`
 * (`@/lib/booking-mutations`).
 *
 * v4 correction 3: these builders used to live inline inside `rescheduleBookingAction`
 * (`schedule/actions.ts`), closing directly over a live Supabase client obtained from
 * `createClient()`. That made their `recoverFromUncertainRun()` behavior — the exact
 * logic an independent safety audit found unsafe in Batch 1B v3 — untestable without a
 * live database. Extracted here and parameterized by `RescheduleStepContext.db`, a
 * minimal duck-typed interface matching only the query shapes these builders actually
 * use, so tests can inject an in-memory fake and exercise the real recovery logic
 * directly (see `test/reschedule-steps.test.ts`), not just a hand-written double of the
 * abstract `CompensatableStep` contract.
 *
 * OWNERSHIP-SAFE RECOVERY (v4 correction 1). None of the tables these steps touch carry
 * a per-request ownership token — only a generic `updated_at` (and `grooming_job_pets`
 * carries no concurrency column at all). A freshly reread `updated_at` therefore proves
 * nothing about who produced a row's current state; it can only guard a *subsequent*
 * write against racing a *third* writer, not establish that *this* request is the one
 * that produced what is already there. Every `recoverFromUncertainRun()` below follows
 * one rule: the write is provably NOT applied only when the row's complete current
 * state — every field this step captured before running, `updated_at` included — still
 * equals the pre-run snapshot exactly. Any deviation from that snapshot, for any reason,
 * is ownership-ambiguous and is reported as `{ applied: true, restored: false }` without
 * attempting any write. None of these methods perform a restore write anymore: given the
 * schema has no ownership token, no write here could ever be proven safe.
 */
import { parseTstzRange } from "@/lib/availability";
import type { CompensatableStep, MutationFailure, RecoveryOutcome, StepOutcome } from "@/lib/booking-mutations";
import type { BookingResourceSnapshot } from "@/lib/schedule";

/** One row as returned by a `RescheduleTableQuery` read. Column values are untyped. */
export type RescheduleDbRow = Record<string, unknown>;

export interface RescheduleDbResult<T> {
  data: T | null;
  error: MutationFailure | null;
}

/**
 * Minimal duck-typed subset of the Supabase PostgREST query-builder chain these step
 * builders use: `.from(table)`, any number of `.update()`/`.insert()`/`.select()`/
 * `.eq()`/`.is()`, then either awaited directly (resolves an array of affected/matched
 * rows) or via `.maybeSingle()` (resolves at most one row). The real Supabase client
 * satisfies this structurally at runtime; production wiring casts it to this type at the
 * single call site in `schedule/actions.ts` because its generated per-table types don't
 * structurally match a hand-written generic interface, even though the chain shape does.
 */
export interface RescheduleTableQuery {
  update(patch: Record<string, unknown>): RescheduleTableQuery;
  insert(row: Record<string, unknown>): RescheduleTableQuery;
  select(columns: string): RescheduleTableQuery;
  eq(column: string, value: unknown): RescheduleTableQuery;
  is(column: string, value: unknown): RescheduleTableQuery;
  maybeSingle(): Promise<RescheduleDbResult<RescheduleDbRow>>;
  then<TResult1 = RescheduleDbResult<RescheduleDbRow[]>, TResult2 = never>(
    onfulfilled?: ((value: RescheduleDbResult<RescheduleDbRow[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

export interface RescheduleDbClient {
  from(table: string): RescheduleTableQuery;
  schema(name: string): { rpc(fn: string, args: Record<string, unknown>): Promise<{ error: MutationFailure | null }> };
}

export interface RescheduleOriginalBooking {
  startsAt: string;
  endsAt: string;
  fulfillmentMode: string;
  notes: string | null;
}

export interface RescheduleTargetBooking {
  startsAt: string;
  endsAt: string;
  fulfillmentMode: string;
  notes: string | null;
}

/** Everything the step builders below need, shared across every step of one reschedule. */
export interface RescheduleStepContext {
  db: RescheduleDbClient;
  organizationId: string;
  branchId: string;
  bookingId: string;
  originalStatus: string;
  originalUpdatedAt: string;
  original: RescheduleOriginalBooking;
  target: RescheduleTargetBooking;
  /** Postgres tstzrange literal for the new window, e.g. `[2026-01-01T09:00:00Z,...)`. */
  during: string;
  snapshotByResourceId: ReadonlyMap<string, BookingResourceSnapshot>;
}

export function buildBookingRowStep(ctx: RescheduleStepContext): CompensatableStep {
  let appliedUpdatedAt: string | null = null;
  return {
    name: "booking_row",
    async run(): Promise<StepOutcome> {
      const result = await ctx.db
        .from("bookings")
        .update({
          starts_at: ctx.target.startsAt,
          ends_at: ctx.target.endsAt,
          fulfillment_mode: ctx.target.fulfillmentMode,
          notes: ctx.target.notes,
        })
        .eq("organization_id", ctx.organizationId)
        .eq("branch_id", ctx.branchId)
        .eq("id", ctx.bookingId)
        .eq("status", ctx.originalStatus)
        .eq("updated_at", ctx.originalUpdatedAt)
        .is("deleted_at", null)
        .select("updated_at");
      if (result.error) return { ok: false, stale: false, error: result.error };
      if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
      appliedUpdatedAt = String(result.data[0].updated_at);
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      const result = await ctx.db
        .from("bookings")
        .update({
          starts_at: ctx.original.startsAt,
          ends_at: ctx.original.endsAt,
          fulfillment_mode: ctx.original.fulfillmentMode,
          notes: ctx.original.notes,
        })
        .eq("organization_id", ctx.organizationId)
        .eq("branch_id", ctx.branchId)
        .eq("id", ctx.bookingId)
        .eq("updated_at", appliedUpdatedAt ?? "")
        .select("id");
      if (result.error) return { ok: false, stale: false, error: result.error };
      if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
      return { ok: true };
    },
    // v4 correction 1: read-only. Never restores a booking row after a concurrent
    // terminal-status change — any status other than the pre-run snapshot's own status
    // fails the "complete state unchanged" test below and is reported ambiguous.
    async recoverFromUncertainRun(): Promise<RecoveryOutcome> {
      const current = await ctx.db
        .from("bookings")
        .select("starts_at,ends_at,fulfillment_mode,notes,status,updated_at")
        .eq("organization_id", ctx.organizationId)
        .eq("branch_id", ctx.branchId)
        .eq("id", ctx.bookingId)
        .is("deleted_at", null)
        .maybeSingle();
      if (current.error) throw new Error("booking_row_recovery_read_failed");
      if (!current.data) {
        // Not visible under this scope at all (e.g. concurrently soft-deleted) — that is
        // not the pre-run snapshot, so this request cannot prove its write never applied.
        return { applied: true, restored: false };
      }
      const row = current.data;
      const unchanged =
        row.starts_at === ctx.original.startsAt &&
        row.ends_at === ctx.original.endsAt &&
        row.fulfillment_mode === ctx.original.fulfillmentMode &&
        (row.notes ?? null) === (ctx.original.notes ?? null) &&
        row.status === ctx.originalStatus &&
        row.updated_at === ctx.originalUpdatedAt;
      return unchanged ? { applied: false } : { applied: true, restored: false };
    },
  };
}

export function buildDeactivateStep(ctx: RescheduleStepContext, resourceId: string): CompensatableStep {
  const snapshot = ctx.snapshotByResourceId.get(resourceId);
  let appliedUpdatedAt: string | null = null;
  return {
    name: `deactivate:${resourceId}`,
    async run(): Promise<StepOutcome> {
      if (!snapshot) return { ok: false, stale: false, error: null };
      const result = await ctx.db
        .from("booking_resources")
        .update({ is_active: false })
        .eq("organization_id", ctx.organizationId)
        .eq("booking_id", ctx.bookingId)
        .eq("resource_id", resourceId)
        .eq("is_active", true)
        .eq("updated_at", snapshot.updatedAt)
        .select("resource_id,updated_at");
      if (result.error) return { ok: false, stale: false, error: result.error };
      if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
      appliedUpdatedAt = String(result.data[0].updated_at);
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      if (!snapshot) return { ok: false, stale: false, error: null };
      const result = await ctx.db
        .from("booking_resources")
        .update({ is_active: true, during: snapshot.during })
        .eq("organization_id", ctx.organizationId)
        .eq("booking_id", ctx.bookingId)
        .eq("resource_id", resourceId)
        .eq("is_active", false)
        .eq("updated_at", appliedUpdatedAt ?? "")
        .select("resource_id");
      if (result.error) return { ok: false, stale: false, error: result.error };
      if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
      return { ok: true };
    },
    // v4 correction 1: read-only. Never reactivates a row this request cannot prove it
    // deactivated — is_active already false is consistent with a concurrent cancellation
    // having released the resource, not only with this step's own write.
    async recoverFromUncertainRun(): Promise<RecoveryOutcome> {
      if (!snapshot) return { applied: false };
      const current = await ctx.db
        .from("booking_resources")
        .select("is_active,during,updated_at")
        .eq("organization_id", ctx.organizationId)
        .eq("booking_id", ctx.bookingId)
        .eq("resource_id", resourceId)
        .maybeSingle();
      if (current.error) throw new Error("resource_row_recovery_read_failed");
      if (!current.data) return { applied: true, restored: false };
      const row = current.data;
      const unchanged = row.is_active === true && row.during === snapshot.during && row.updated_at === snapshot.updatedAt;
      return unchanged ? { applied: false } : { applied: true, restored: false };
    },
  };
}

export function buildKeepStep(ctx: RescheduleStepContext, resourceId: string): CompensatableStep {
  const snapshot = ctx.snapshotByResourceId.get(resourceId);
  let appliedUpdatedAt: string | null = null;
  return {
    name: `keep:${resourceId}`,
    async run(): Promise<StepOutcome> {
      if (!snapshot) return { ok: false, stale: false, error: null };
      const result = await ctx.db
        .from("booking_resources")
        .update({ during: ctx.during, is_active: true })
        .eq("organization_id", ctx.organizationId)
        .eq("booking_id", ctx.bookingId)
        .eq("resource_id", resourceId)
        .eq("is_active", true)
        .eq("updated_at", snapshot.updatedAt)
        .select("resource_id,updated_at");
      if (result.error) return { ok: false, stale: false, error: result.error };
      if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
      appliedUpdatedAt = String(result.data[0].updated_at);
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      if (!snapshot) return { ok: false, stale: false, error: null };
      const result = await ctx.db
        .from("booking_resources")
        .update({ during: snapshot.during })
        .eq("organization_id", ctx.organizationId)
        .eq("booking_id", ctx.bookingId)
        .eq("resource_id", resourceId)
        .eq("is_active", true)
        .eq("updated_at", appliedUpdatedAt ?? "")
        .select("resource_id");
      if (result.error) return { ok: false, stale: false, error: result.error };
      if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
      return { ok: true };
    },
    // v4 correction 1: read-only. A concurrent modification of this resource's `during`
    // (or a concurrent deactivation) fails the "complete state unchanged" test and is
    // reported ambiguous rather than overwritten.
    async recoverFromUncertainRun(): Promise<RecoveryOutcome> {
      if (!snapshot) return { applied: false };
      const current = await ctx.db
        .from("booking_resources")
        .select("is_active,during,updated_at")
        .eq("organization_id", ctx.organizationId)
        .eq("booking_id", ctx.bookingId)
        .eq("resource_id", resourceId)
        .maybeSingle();
      if (current.error) throw new Error("resource_row_recovery_read_failed");
      if (!current.data) return { applied: true, restored: false };
      const row = current.data;
      const unchanged = row.is_active === true && row.during === snapshot.during && row.updated_at === snapshot.updatedAt;
      return unchanged ? { applied: false } : { applied: true, restored: false };
    },
  };
}

export function buildActivateStep(ctx: RescheduleStepContext, resourceId: string): CompensatableStep {
  // Present only when a released (inactive) row already existed for this resource.
  const snapshot = ctx.snapshotByResourceId.get(resourceId);
  let appliedUpdatedAt: string | null = null;
  return {
    name: `activate:${resourceId}`,
    async run(): Promise<StepOutcome> {
      if (snapshot) {
        // Reactivating a row this booking already had: a guarded update on the
        // snapshot's own updated_at, never an upsert — an upsert here would silently
        // overwrite whatever a concurrent request has since done to this exact row.
        const result = await ctx.db
          .from("booking_resources")
          .update({ is_active: true, during: ctx.during })
          .eq("organization_id", ctx.organizationId)
          .eq("booking_id", ctx.bookingId)
          .eq("resource_id", resourceId)
          .eq("is_active", false)
          .eq("updated_at", snapshot.updatedAt)
          .select("resource_id,updated_at");
        if (result.error) return { ok: false, stale: false, error: result.error };
        if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
        appliedUpdatedAt = String(result.data[0].updated_at);
        return { ok: true };
      }
      // No prior row at all for this resource on this booking: a genuine insert. The
      // GiST exclusion constraint is still the authority against a concurrent
      // double-assignment; this is not a race-prevention guard, only a correctness one.
      const result = await ctx.db
        .from("booking_resources")
        .insert({ booking_id: ctx.bookingId, resource_id: resourceId, organization_id: ctx.organizationId, during: ctx.during, is_active: true })
        .select("resource_id,updated_at");
      if (result.error) return { ok: false, stale: false, error: result.error };
      if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
      appliedUpdatedAt = String(result.data[0].updated_at);
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      if (snapshot) {
        const result = await ctx.db
          .from("booking_resources")
          .update({ is_active: snapshot.isActive, during: snapshot.during })
          .eq("organization_id", ctx.organizationId)
          .eq("booking_id", ctx.bookingId)
          .eq("resource_id", resourceId)
          .eq("updated_at", appliedUpdatedAt ?? "")
          .select("resource_id");
        if (result.error) return { ok: false, stale: false, error: result.error };
        if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
        return { ok: true };
      }
      // No prior row for this resource on this booking: never delete it. Deactivating
      // the row this step itself created is the only reversal that preserves history.
      const result = await ctx.db
        .from("booking_resources")
        .update({ is_active: false })
        .eq("organization_id", ctx.organizationId)
        .eq("booking_id", ctx.bookingId)
        .eq("resource_id", resourceId)
        .eq("is_active", true)
        .eq("updated_at", appliedUpdatedAt ?? "")
        .select("resource_id");
      if (result.error) return { ok: false, stale: false, error: result.error };
      if (!result.data || result.data.length !== 1) return { ok: false, stale: true };
      return { ok: true };
    },
    // v4 correction 1: read-only.
    // - Reactivation case (snapshot exists): a deviation from the pre-run snapshot is
    //   ownership-ambiguous, same as every other resource step.
    // - Genuine-insert case (no snapshot): absence of a row means the insert never
    //   applied. A row's mere PRESENCE does not prove it is the one this request
    //   inserted — a concurrent request may have inserted its own assignment for this
    //   exact resource after our uncertain run — so it is never deactivated by recovery.
    async recoverFromUncertainRun(): Promise<RecoveryOutcome> {
      const current = await ctx.db
        .from("booking_resources")
        .select("is_active,during,updated_at")
        .eq("organization_id", ctx.organizationId)
        .eq("booking_id", ctx.bookingId)
        .eq("resource_id", resourceId)
        .maybeSingle();
      if (current.error) throw new Error("resource_row_recovery_read_failed");

      if (snapshot) {
        if (!current.data) return { applied: true, restored: false };
        const row = current.data;
        const unchanged = row.is_active === snapshot.isActive && row.during === snapshot.during && row.updated_at === snapshot.updatedAt;
        return unchanged ? { applied: false } : { applied: true, restored: false };
      }

      return current.data ? { applied: true, restored: false } : { applied: false };
    },
  };
}

export function buildPetStep(ctx: RescheduleStepContext, jobPetId: string, originalResourceId: string | null, newResourceId: string): CompensatableStep {
  const app = ctx.db.schema("app");
  return {
    name: `pet:${jobPetId}`,
    async run(): Promise<StepOutcome> {
      // The controlled path: assembly_assign_pet_resource re-authorizes, verifies the
      // resource is active and in the booking's branch, and writes a timeline event.
      // It has no return value to check a row count against — an absent error is the
      // only success signal the frozen RPC gives.
      const { error } = await app.rpc("assembly_assign_pet_resource", { p_pet: jobPetId, p_resource: newResourceId });
      if (error) return { ok: false, stale: false, error };
      return { ok: true };
    },
    async compensate(): Promise<StepOutcome> {
      if (!originalResourceId) {
        // Honest limitation: the frozen RPC has no "unassign" call, so a pet that
        // started with no groomer cannot be restored to that state. This is the one
        // case that forces `partially_applied` even when every other layer restores
        // cleanly, and it is documented here rather than silently reported as success.
        return { ok: false, stale: false, error: null };
      }
      const { error } = await app.rpc("assembly_assign_pet_resource", { p_pet: jobPetId, p_resource: originalResourceId });
      if (error) return { ok: false, stale: false, error };
      return { ok: true };
    },
    // v4 correction 1: read-only. This table carries no per-row concurrency token at all
    // (the frozen schema gives it none), and the RPC's own success signal is only the
    // absence of an error — no comparison here can prove which request produced a change
    // away from the original assignment. Recovery never re-invokes the RPC: doing so
    // could not distinguish reverting our own uncertain write from overwriting a
    // concurrent reassignment.
    async recoverFromUncertainRun(): Promise<RecoveryOutcome> {
      const current = await ctx.db
        .from("grooming_job_pets")
        .select("assigned_resource_id,deleted_at")
        .eq("organization_id", ctx.organizationId)
        .eq("id", jobPetId)
        .maybeSingle();
      if (current.error) throw new Error("pet_row_recovery_read_failed");
      if (!current.data) return { applied: true, restored: false };
      const row = current.data;
      const unchanged = row.deleted_at === null && (row.assigned_resource_id ?? null) === (originalResourceId ?? null);
      return unchanged ? { applied: false } : { applied: true, restored: false };
    },
  };
}

/**
 * Retained only so a caller that already has a raw tstzrange literal and wants to parse
 * it (e.g. for logging or a UI label) does not need a second import of `@/lib/availability`.
 * Not used by recovery — recovery compares raw snapshot values, never parsed ranges.
 */
export { parseTstzRange };
