import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActivateStep,
  buildBookingRowStep,
  buildDeactivateStep,
  buildKeepStep,
  buildPetStep,
  type RescheduleDbClient,
  type RescheduleDbResult,
  type RescheduleDbRow,
  type RescheduleStepContext,
  type RescheduleTableQuery,
} from "../src/lib/reschedule-steps";
import type { BookingResourceSnapshot } from "../src/lib/schedule";

/**
 * v4 correction 3: these tests exercise the real, concrete step builders from
 * reschedule-steps.ts against an in-memory fake `RescheduleDbClient`, not a hand-written
 * double of the `CompensatableStep` interface. The fake below simulates only the row
 * matching and update/insert semantics these builders actually depend on — it proves
 * nothing about RLS or PostgREST, but it does exercise the real ownership-safe recovery
 * logic (v4 correction 1) against state a concurrent request could plausibly have left
 * behind, which the purely structural checks in mutation-safety.test.ts cannot.
 */

const ORG = "018f3e10-7b1a-7c11-8c2a-9a4de6e42001";
const BRANCH = "018f3e10-7b1a-7c11-8c2a-9a4de6e42002";
const BOOKING = "018f3e10-7b1a-7c11-8c2a-9a4de6e42003";
const RESOURCE_A = "018f3e10-7b1a-7c11-8c2a-9a4de6e42004";
const RESOURCE_B = "018f3e10-7b1a-7c11-8c2a-9a4de6e42005";
const PET = "018f3e10-7b1a-7c11-8c2a-9a4de6e42006";

class FakeQuery implements RescheduleTableQuery {
  private eqFilters: Array<[string, unknown]> = [];
  private isFilters: Array<[string, unknown]> = [];
  private op: { kind: "read" } | { kind: "update"; patch: Record<string, unknown> } | { kind: "insert"; row: Record<string, unknown> } = {
    kind: "read",
  };

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  update(patch: Record<string, unknown>): RescheduleTableQuery {
    this.op = { kind: "update", patch };
    return this;
  }
  insert(row: Record<string, unknown>): RescheduleTableQuery {
    this.op = { kind: "insert", row };
    return this;
  }
  select(): RescheduleTableQuery {
    return this;
  }
  eq(column: string, value: unknown): RescheduleTableQuery {
    this.eqFilters.push([column, value]);
    return this;
  }
  is(column: string, value: unknown): RescheduleTableQuery {
    this.isFilters.push([column, value]);
    return this;
  }
  async maybeSingle(): Promise<RescheduleDbResult<RescheduleDbRow>> {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    return { data: data?.[0] ?? null, error: null };
  }
  then<TResult1 = RescheduleDbResult<RescheduleDbRow[]>, TResult2 = never>(
    onfulfilled?: ((value: RescheduleDbResult<RescheduleDbRow[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private matches(row: RescheduleDbRow): boolean {
    return (
      this.eqFilters.every(([column, value]) => row[column] === value) &&
      this.isFilters.every(([column, value]) => (row[column] ?? null) === value)
    );
  }

  private async run(): Promise<RescheduleDbResult<RescheduleDbRow[]>> {
    const rows = this.db.tables.get(this.table) ?? [];
    if (this.op.kind === "read") {
      return { data: rows.filter((row) => this.matches(row)), error: null };
    }
    if (this.op.kind === "update") {
      const matched = rows.filter((row) => this.matches(row));
      const updatedAt = this.db.tick();
      for (const row of matched) {
        Object.assign(row, this.op.patch);
        row.updated_at = updatedAt;
      }
      return { data: matched, error: null };
    }
    const inserted: RescheduleDbRow = { ...this.op.row, updated_at: this.db.tick() };
    rows.push(inserted);
    this.db.tables.set(this.table, rows);
    return { data: [inserted], error: null };
  }
}

class FakeDb implements RescheduleDbClient {
  tables = new Map<string, RescheduleDbRow[]>();
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  private counter = 0;

  /** A monotonically increasing updated_at, distinct from every value tests seed by hand. */
  tick(): string {
    this.counter += 1;
    return `2026-08-02T00:00:${String(this.counter).padStart(2, "0")}.000Z`;
  }

  seed(table: string, row: RescheduleDbRow): void {
    const rows = this.tables.get(table) ?? [];
    rows.push(row);
    this.tables.set(table, rows);
  }

  /** Mutates a row directly, bypassing any step — models a concurrent request's own write. */
  concurrentlyMutate(table: string, match: Partial<RescheduleDbRow>, patch: Record<string, unknown>): void {
    const rows = this.tables.get(table) ?? [];
    const row = rows.find((candidate) => Object.entries(match).every(([column, value]) => candidate[column] === value));
    if (!row) throw new Error(`no matching ${table} row to mutate`);
    Object.assign(row, patch, { updated_at: this.tick() });
  }

  from(table: string): RescheduleTableQuery {
    return new FakeQuery(this, table);
  }

  schema() {
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        this.rpcCalls.push({ fn, args });
        return { error: null };
      },
    };
  }
}

function baseContext(db: FakeDb, overrides: Partial<RescheduleStepContext> = {}): RescheduleStepContext {
  return {
    db,
    organizationId: ORG,
    branchId: BRANCH,
    bookingId: BOOKING,
    originalStatus: "confirmed",
    originalUpdatedAt: "2026-08-02T00:00:01.000Z",
    original: {
      startsAt: "2026-08-02T02:00:00.000Z",
      endsAt: "2026-08-02T03:00:00.000Z",
      fulfillmentMode: "home",
      notes: "original notes",
    },
    target: {
      startsAt: "2026-08-02T04:00:00.000Z",
      endsAt: "2026-08-02T05:00:00.000Z",
      fulfillmentMode: "home",
      notes: "new notes",
    },
    during: "[2026-08-02T04:00:00+00,2026-08-02T05:00:00+00)",
    snapshotByResourceId: new Map(),
    ...overrides,
  };
}

// ---------- grounding: the real builder actually applies and reverses a write via the DI'd fake db ----------

test("buildDeactivateStep.run() deactivates the row and compensate() restores it, wired to a fake db through the same RescheduleDbClient interface production code uses", async () => {
  const db = new FakeDb();
  const snapshot: BookingResourceSnapshot = {
    resourceId: RESOURCE_A,
    during: "[2026-08-02T02:00:00+00,2026-08-02T03:00:00+00)",
    isActive: true,
    updatedAt: "2026-08-02T00:00:01.000Z",
  };
  db.seed("booking_resources", {
    booking_id: BOOKING,
    resource_id: RESOURCE_A,
    organization_id: ORG,
    during: snapshot.during,
    is_active: true,
    updated_at: snapshot.updatedAt,
  });
  const ctx = baseContext(db, { snapshotByResourceId: new Map([[RESOURCE_A, snapshot]]) });
  const step = buildDeactivateStep(ctx, RESOURCE_A);

  assert.deepEqual(await step.run(), { ok: true });
  assert.equal(db.tables.get("booking_resources")![0].is_active, false);

  assert.deepEqual(await step.compensate(), { ok: true });
  const row = db.tables.get("booking_resources")![0];
  assert.equal(row.is_active, true);
  assert.equal(row.during, snapshot.during);
});

// ---------- required scenario: concurrent cancellation before uncertain deactivate recovery ----------

test("concurrent cancellation deactivates a resource before uncertain deactivate recovery; recovery must not reactivate it", async () => {
  const db = new FakeDb();
  const snapshot: BookingResourceSnapshot = {
    resourceId: RESOURCE_A,
    during: "[2026-08-02T02:00:00+00,2026-08-02T03:00:00+00)",
    isActive: true,
    updatedAt: "2026-08-02T00:00:01.000Z",
  };
  db.seed("booking_resources", {
    booking_id: BOOKING,
    resource_id: RESOURCE_A,
    organization_id: ORG,
    during: snapshot.during,
    is_active: true,
    updated_at: snapshot.updatedAt,
  });
  const ctx = baseContext(db, { snapshotByResourceId: new Map([[RESOURCE_A, snapshot]]) });
  const step = buildDeactivateStep(ctx, RESOURCE_A);

  // Models trg_bookings_release_resources firing off a concurrent cancellation before our
  // uncertain run's own recovery gets a chance to look at the row.
  db.concurrentlyMutate("booking_resources", { booking_id: BOOKING, resource_id: RESOURCE_A }, { is_active: false });

  const outcome = await step.recoverFromUncertainRun!();
  assert.deepEqual(outcome, { applied: true, restored: false }, "an is_active mismatch must be reported ambiguous, not not-applied");

  const row = db.tables.get("booking_resources")![0];
  assert.equal(row.is_active, false, "recovery must never reactivate a row it cannot prove ownership of");
});

// ---------- required scenario: concurrent resource modification before uncertain keep/activate recovery ----------

test("a concurrent modification of a resource's window before uncertain keep recovery is not overwritten", async () => {
  const db = new FakeDb();
  const originalDuring = "[2026-08-02T02:00:00+00,2026-08-02T03:00:00+00)";
  const snapshot: BookingResourceSnapshot = { resourceId: RESOURCE_A, during: originalDuring, isActive: true, updatedAt: "2026-08-02T00:00:01.000Z" };
  db.seed("booking_resources", {
    booking_id: BOOKING,
    resource_id: RESOURCE_A,
    organization_id: ORG,
    during: originalDuring,
    is_active: true,
    updated_at: snapshot.updatedAt,
  });
  const ctx = baseContext(db, { snapshotByResourceId: new Map([[RESOURCE_A, snapshot]]) });
  const step = buildKeepStep(ctx, RESOURCE_A);

  const concurrentDuring = "[2026-08-02T06:00:00+00,2026-08-02T07:00:00+00)";
  db.concurrentlyMutate("booking_resources", { booking_id: BOOKING, resource_id: RESOURCE_A }, { during: concurrentDuring });

  const outcome = await step.recoverFromUncertainRun!();
  assert.deepEqual(outcome, { applied: true, restored: false });

  const row = db.tables.get("booking_resources")![0];
  assert.equal(row.during, concurrentDuring, "recovery must not overwrite a concurrent request's window with the stale snapshot");
});

test("a concurrent reactivation of a resource before uncertain activate recovery is not overwritten", async () => {
  const db = new FakeDb();
  const originalDuring = "[2026-08-02T02:00:00+00,2026-08-02T03:00:00+00)";
  const snapshot: BookingResourceSnapshot = { resourceId: RESOURCE_B, during: originalDuring, isActive: false, updatedAt: "2026-08-02T00:00:01.000Z" };
  db.seed("booking_resources", {
    booking_id: BOOKING,
    resource_id: RESOURCE_B,
    organization_id: ORG,
    during: originalDuring,
    is_active: false,
    updated_at: snapshot.updatedAt,
  });
  const ctx = baseContext(db, { snapshotByResourceId: new Map([[RESOURCE_B, snapshot]]) });
  const step = buildActivateStep(ctx, RESOURCE_B);

  // A concurrent request reactivated this exact row for its own purposes before our recovery ran.
  const concurrentDuring = "[2026-08-02T08:00:00+00,2026-08-02T09:00:00+00)";
  db.concurrentlyMutate("booking_resources", { booking_id: BOOKING, resource_id: RESOURCE_B }, { is_active: true, during: concurrentDuring });

  const outcome = await step.recoverFromUncertainRun!();
  assert.deepEqual(outcome, { applied: true, restored: false });

  const row = db.tables.get("booking_resources")![0];
  assert.equal(row.is_active, true);
  assert.equal(row.during, concurrentDuring, "recovery must not clobber the concurrent request's own reactivation");
});

// ---------- required scenario: an uncertain insert followed by an existing row does not deactivate it ----------

test("an uncertain insert followed by an existing row does not deactivate that row", async () => {
  const db = new FakeDb();
  const ctx = baseContext(db, { snapshotByResourceId: new Map() }); // no snapshot -> genuine-insert branch
  const step = buildActivateStep(ctx, RESOURCE_A);

  // Either our own insert succeeded, or a concurrent request inserted its own row for this
  // exact resource after our uncertain run — recovery cannot tell them apart, so presence
  // alone must never trigger a deactivation.
  db.seed("booking_resources", {
    booking_id: BOOKING,
    resource_id: RESOURCE_A,
    organization_id: ORG,
    during: "[2026-08-02T04:00:00+00,2026-08-02T05:00:00+00)",
    is_active: true,
    updated_at: "2026-08-02T00:00:05.000Z",
  });

  const outcome = await step.recoverFromUncertainRun!();
  assert.deepEqual(outcome, { applied: true, restored: false }, "presence of any row must be treated as ambiguous, not proof of our own insert");

  const row = db.tables.get("booking_resources")![0];
  assert.equal(row.is_active, true, "recovery must never deactivate a row it cannot prove is the one it inserted");
});

test("an uncertain insert with no row at all is correctly reported as not applied", async () => {
  const db = new FakeDb();
  const ctx = baseContext(db, { snapshotByResourceId: new Map() });
  const step = buildActivateStep(ctx, RESOURCE_A);

  const outcome = await step.recoverFromUncertainRun!();
  assert.deepEqual(outcome, { applied: false });
});

// ---------- required scenario: a terminal booking status reached before uncertain booking-row recovery ----------

test("a terminal booking status reached before uncertain booking-row recovery is not updated", async () => {
  const db = new FakeDb();
  const original = {
    startsAt: "2026-08-02T02:00:00.000Z",
    endsAt: "2026-08-02T03:00:00.000Z",
    fulfillmentMode: "home",
    notes: "original notes",
  };
  const originalUpdatedAt = "2026-08-02T00:00:01.000Z";
  db.seed("bookings", {
    id: BOOKING,
    organization_id: ORG,
    branch_id: BRANCH,
    deleted_at: null,
    starts_at: original.startsAt,
    ends_at: original.endsAt,
    fulfillment_mode: original.fulfillmentMode,
    notes: original.notes,
    status: "confirmed",
    updated_at: originalUpdatedAt,
  });
  const ctx = baseContext(db, { original, originalStatus: "confirmed", originalUpdatedAt });
  const step = buildBookingRowStep(ctx);

  // A concurrent request cancels the booking (a terminal status) after our uncertain run.
  db.concurrentlyMutate("bookings", { id: BOOKING }, { status: "canceled" });

  const outcome = await step.recoverFromUncertainRun!();
  assert.deepEqual(outcome, { applied: true, restored: false }, "a status change alone must make ownership unprovable");

  const row = db.tables.get("bookings")![0];
  assert.equal(row.status, "canceled", "recovery must never restore a booking row after a concurrent terminal-status change");
  assert.equal(row.starts_at, original.startsAt, "recovery took no action either way — the timing fields were simply never touched");
});

test("booking-row recovery reports not applied only when the complete current state still matches the original snapshot exactly", async () => {
  const db = new FakeDb();
  const original = {
    startsAt: "2026-08-02T02:00:00.000Z",
    endsAt: "2026-08-02T03:00:00.000Z",
    fulfillmentMode: "home",
    notes: null as string | null,
  };
  const originalUpdatedAt = "2026-08-02T00:00:01.000Z";
  db.seed("bookings", {
    id: BOOKING,
    organization_id: ORG,
    branch_id: BRANCH,
    deleted_at: null,
    starts_at: original.startsAt,
    ends_at: original.endsAt,
    fulfillment_mode: original.fulfillmentMode,
    notes: null,
    status: "confirmed",
    updated_at: originalUpdatedAt,
  });
  const ctx = baseContext(db, { original, originalStatus: "confirmed", originalUpdatedAt });
  const step = buildBookingRowStep(ctx);

  const outcome = await step.recoverFromUncertainRun!();
  assert.deepEqual(outcome, { applied: false });
});

// ---------- pet recovery against a concurrent reassignment (grooming_job_pets has no concurrency token) ----------

test("a pet reassigned by a concurrent request before uncertain pet recovery is not reverted, and the RPC is never re-invoked by recovery", async () => {
  const db = new FakeDb();
  db.seed("grooming_job_pets", { id: PET, organization_id: ORG, assigned_resource_id: RESOURCE_A, deleted_at: null });
  const ctx = baseContext(db);
  const step = buildPetStep(ctx, PET, RESOURCE_A, RESOURCE_B);

  db.concurrentlyMutate("grooming_job_pets", { id: PET }, { assigned_resource_id: RESOURCE_B });

  const outcome = await step.recoverFromUncertainRun!();
  assert.deepEqual(outcome, { applied: true, restored: false });
  assert.equal(db.rpcCalls.length, 0, "recovery must never re-invoke assembly_assign_pet_resource — its success cannot prove ownership");

  const row = db.tables.get("grooming_job_pets")![0];
  assert.equal(row.assigned_resource_id, RESOURCE_B, "recovery must not revert a concurrent request's own reassignment");
});
