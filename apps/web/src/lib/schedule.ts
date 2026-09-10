/**
 * Function index:
 * - loadScheduleWorkspace: loads the dispatcher calendar for one accessible branch and date window.
 * - loadBookingDetail: loads one booking's detail, bound to the active branch.
 * - readConfiguredHours: reads optional business hours from branch settings.
 * - deriveAssignedResourceIds: resolves the groomer columns a booking occupies, active assignments only.
 *
 * Every query is scoped to the active organization, one branch the membership can
 * actually access, and the visible date window. This is the deliberate opposite of the
 * HomePaw baseline, which loaded every row of seventeen tables on boot.
 *
 * Two correctness properties worth stating explicitly:
 *
 * 1. The booking query uses an OVERLAP condition (`starts_at < windowEnd` and
 *    `ends_at > windowStart`), not `starts_at` containment. A booking that begins before
 *    the window and ends inside it occupies visible time and must be rendered.
 * 2. The groomer restriction is applied inside the query, before the row limit, so the
 *    truncation notice can honestly claim that narrowing recovers rows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { filterAccessibleBranches, isBranchAccessible, type BranchAccess } from "@/lib/authorization";
import {
  DEFAULT_DAY_END_MINUTES,
  DEFAULT_DAY_START_MINUTES,
  type DaySegment,
  type ScheduleView,
  resolveScheduleDays,
  splitIntoDaySegments,
} from "@/lib/schedule-layout";
import { addDaysISO, formatZonedDayLong, formatZonedTime, zonedDateTimeToUtc, zonedDayISO } from "@/lib/timezone";

function assertResult(scope: string, error: { message: string } | null) {
  if (error) throw new Error(`${scope}_failed:${error.message}`);
}

function relationRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}

/** Upper bound on rendered bookings. Exceeding it reports honestly instead of truncating silently. */
export const SCHEDULE_ROW_LIMIT = 400;

/**
 * Two literal select strings rather than one interpolated one: PostgREST needs an inner
 * join to restrict the parent rows by an embedded resource, and a template literal
 * defeats the client's select-type inference.
 *
 * `BOOKING_SELECT_ALL` deliberately omits `!inner`. With the inner join, a booking whose
 * only assignments are released — or which has no assignment at all — would drop out of
 * the unfiltered calendar entirely.
 */
export const BOOKING_SELECT_ALL =
  "id,customer_id,starts_at,ends_at,status,fulfillment_mode,notes,customers(display_name),booking_resources(resource_id,is_active),grooming_jobs(grooming_job_pets(pet_id,status,assigned_resource_id,pets(name),grooming_job_pet_services(service_name_snapshot)))";
export const BOOKING_SELECT_FILTERED =
  "id,customer_id,starts_at,ends_at,status,fulfillment_mode,notes,customers(display_name),booking_resources!inner(resource_id,is_active),grooming_jobs(grooming_job_pets(pet_id,status,assigned_resource_id,pets(name),grooming_job_pet_services(service_name_snapshot)))";

/**
 * Derives the groomer columns a booking occupies.
 *
 * `booking_resources.is_active` is set false by `tg_bookings_release_resources` when a
 * booking is canceled or marked no-show; the row is retained rather than deleted, so it
 * remains readable and must be ignored here. Anything other than a literal `true` is
 * treated as released, so a null or absent flag cannot place a booking under a groomer.
 *
 * `grooming_job_pets.assigned_resource_id` is a separate authoritative per-pet
 * assignment with no active flag of its own, and is preserved as-is so multi-pet
 * bookings keep appearing under each pet's groomer.
 */
export function deriveAssignedResourceIds(
  assignments: readonly unknown[],
  petResourceIds: readonly (string | null)[],
  branchResourceIds: ReadonlySet<string>,
  appliedResourceIds: readonly string[],
): string[] {
  const activeAssignmentIds = assignments.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const assignment = entry as Record<string, unknown>;
    if (assignment.is_active !== true) return [];
    return typeof assignment.resource_id === "string" ? [assignment.resource_id] : [];
  });
  const petIds = petResourceIds.flatMap((id) => (typeof id === "string" && id.length > 0 ? [id] : []));
  const filtering = appliedResourceIds.length > 0;
  return [...new Set([...activeAssignmentIds, ...petIds])].filter(
    (id) => branchResourceIds.has(id) && (!filtering || appliedResourceIds.includes(id)),
  );
}

export interface ScheduleBranch {
  id: string;
  name: string;
  timezone: string;
  dayStartMinutes: number;
  dayEndMinutes: number;
}

export interface ScheduleResource {
  id: string;
  name: string;
}

export interface SchedulePetLine {
  petId: string;
  petName: string;
  status: string;
  resourceId: string | null;
  services: string[];
}

export interface ScheduleBooking {
  id: string;
  segments: DaySegment[];
  startLabel: string;
  endLabel: string;
  status: string;
  fulfillmentMode: string;
  customerId: string;
  customerName: string;
  resourceIds: string[];
  pets: SchedulePetLine[];
  notes: string | null;
}

export interface ScheduleBlackout {
  id: string;
  resourceId: string;
  segments: DaySegment[];
  startLabel: string;
  endLabel: string;
  reason: string | null;
}

export interface ScheduleWorkspace {
  branches: ScheduleBranch[];
  activeBranch: ScheduleBranch;
  /** Columns to render — the selected groomers, or all of them when unfiltered. */
  resources: ScheduleResource[];
  /** Every active staff resource in the branch, so the filter chips stay usable while filtered. */
  branchResources: ScheduleResource[];
  /** Groomer ids actually applied to the query, after validation. */
  appliedResourceIds: string[];
  days: string[];
  bookings: ScheduleBooking[];
  blackouts: ScheduleBlackout[];
  truncated: boolean;
}

function readConfiguredHours(settings: unknown) {
  const container = typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>) : {};
  const schedule = typeof container.schedule === "object" && container.schedule !== null ? (container.schedule as Record<string, unknown>) : {};
  const start = Number(schedule.dayStartMinutes);
  const end = Number(schedule.dayEndMinutes);
  return {
    dayStartMinutes: Number.isInteger(start) && start >= 0 && start < 1440 ? start : DEFAULT_DAY_START_MINUTES,
    dayEndMinutes: Number.isInteger(end) && end > 0 && end <= 1440 ? end : DEFAULT_DAY_END_MINUTES,
  };
}

export class NoAccessibleBranchError extends Error {
  constructor() {
    super("no_accessible_branch");
    this.name = "NoAccessibleBranchError";
  }
}

export async function loadScheduleWorkspace(
  supabase: SupabaseClient,
  organizationId: string,
  branchAccess: BranchAccess,
  options: { view: ScheduleView; anchorISO: string; branchId?: string; resourceIds?: readonly string[] },
): Promise<ScheduleWorkspace> {
  const branchResult = await supabase
    .from("branches")
    .select("id,name,timezone,settings")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("name");
  assertResult("schedule_branches", branchResult.error);

  const organizationBranches: ScheduleBranch[] = (branchResult.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    ...readConfiguredHours(row.settings),
  }));

  // The branches table's RLS is organization-scoped and does not apply app.has_branch,
  // so the read above can return branches this membership may not work in. Branch
  // visibility is therefore applied here, from branches.all plus explicit grants.
  const branches = filterAccessibleBranches(organizationBranches, branchAccess);
  if (branches.length === 0) throw new NoAccessibleBranchError();

  const requestedBranch =
    options.branchId && isBranchAccessible(branchAccess, options.branchId)
      ? branches.find((branch) => branch.id === options.branchId)
      : undefined;
  const activeBranch = requestedBranch ?? branches[0];
  const timeZone = activeBranch.timezone;
  const days = resolveScheduleDays(options.view, options.anchorISO);
  const windowStart = zonedDateTimeToUtc(days[0], 0, timeZone).toISOString();
  const windowEnd = zonedDateTimeToUtc(addDaysISO(days[days.length - 1], 1), 0, timeZone).toISOString();

  const resourceResult = await supabase
    .from("resources")
    .select("id,name")
    .eq("organization_id", organizationId)
    .eq("branch_id", activeBranch.id)
    .eq("kind", "staff")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("name");
  assertResult("schedule_resources", resourceResult.error);

  const branchResources: ScheduleResource[] = (resourceResult.data ?? []).map((row) => ({ id: row.id, name: row.name }));
  const branchResourceIds = new Set(branchResources.map((resource) => resource.id));
  // Requested groomer ids are only honored when they are active staff of this branch, so a
  // crafted query parameter cannot reference another branch's or another tenant's resource.
  const appliedResourceIds = [...new Set(options.resourceIds ?? [])].filter((id) => branchResourceIds.has(id));
  const filtering = appliedResourceIds.length > 0;

  const bookingQuery = filtering
    ? supabase
        .from("bookings")
        .select(BOOKING_SELECT_FILTERED)
        .eq("organization_id", organizationId)
        .eq("branch_id", activeBranch.id)
        .lt("starts_at", windowEnd)
        .gt("ends_at", windowStart)
        .is("deleted_at", null)
        // Both assignment predicates are part of the inner join, so they run before the
        // row limit applied further down the chain. A released assignment therefore
        // cannot consume a slot in the limited result set or match a selected groomer.
        .eq("booking_resources.is_active", true)
        .in("booking_resources.resource_id", appliedResourceIds)
    : supabase
        .from("bookings")
        .select(BOOKING_SELECT_ALL)
        .eq("organization_id", organizationId)
        .eq("branch_id", activeBranch.id)
        .lt("starts_at", windowEnd)
        .gt("ends_at", windowStart)
        .is("deleted_at", null)
        // Filtering an embedded resource WITHOUT `!inner` restricts the embedded rows
        // only; parent bookings with no matching assignment are still returned, with an
        // empty array. That is what keeps an unassigned booking visible here.
        .eq("booking_resources.is_active", true);

  // Blackouts follow the same groomer restriction, so a filtered board does not show
  // unavailability bands for groomers whose columns are hidden.
  const blackoutResourceIds = filtering ? appliedResourceIds : [...branchResourceIds];
  const blackoutQuery = supabase
    .from("resource_availability")
    .select("id,resource_id,starts_at,ends_at,notes,metadata")
    .eq("organization_id", organizationId)
    .eq("branch_id", activeBranch.id)
    .eq("kind", "blackout")
    .is("deleted_at", null)
    .not("starts_at", "is", null)
    .lt("starts_at", windowEnd)
    .gt("ends_at", windowStart)
    .in("resource_id", blackoutResourceIds)
    .order("starts_at");

  const [bookingResult, blackoutResult] = await Promise.all([
    bookingQuery.order("starts_at").limit(SCHEDULE_ROW_LIMIT + 1),
    blackoutResourceIds.length > 0 ? blackoutQuery : Promise.resolve({ data: [], error: null }),
  ]);
  assertResult("schedule_bookings", bookingResult.error);
  assertResult("schedule_blackouts", blackoutResult.error);

  const bookingRows = bookingResult.data ?? [];
  const truncated = bookingRows.length > SCHEDULE_ROW_LIMIT;
  const visibleRows = truncated ? bookingRows.slice(0, SCHEDULE_ROW_LIMIT) : bookingRows;

  const bookings: ScheduleBooking[] = visibleRows.flatMap((row) => {
    const starts = new Date(row.starts_at);
    const ends = new Date(row.ends_at);
    const segments = splitIntoDaySegments(starts, ends, days, timeZone);
    if (segments.length === 0) return [];
    const pets: SchedulePetLine[] = relationRows(row.grooming_jobs)
      .flatMap((job) => relationRows(job.grooming_job_pets))
      .map((jobPet) => ({
        petId: typeof jobPet.pet_id === "string" ? jobPet.pet_id : "",
        petName: (() => {
          const name = relationRows(jobPet.pets)[0]?.name;
          return typeof name === "string" ? name : "Hewan";
        })(),
        status: typeof jobPet.status === "string" ? jobPet.status : "pending",
        resourceId: typeof jobPet.assigned_resource_id === "string" ? jobPet.assigned_resource_id : null,
        services: relationRows(jobPet.grooming_job_pet_services).flatMap((line) =>
          typeof line.service_name_snapshot === "string" ? [line.service_name_snapshot] : [],
        ),
      }));
    // Defensive second line of defence: even if the embedded is_active filter above were
    // ever relaxed or behaved differently, a released assignment cannot reach resourceIds.
    const resourceIds = deriveAssignedResourceIds(
      relationRows(row.booking_resources),
      pets.map((pet) => pet.resourceId),
      branchResourceIds,
      appliedResourceIds,
    );
    return [
      {
        id: row.id,
        segments,
        startLabel: formatZonedTime(starts, timeZone),
        endLabel: formatZonedTime(ends, timeZone),
        status: row.status,
        fulfillmentMode: row.fulfillment_mode,
        customerId: row.customer_id,
        customerName: (() => {
          const name = relationRows(row.customers)[0]?.display_name;
          return typeof name === "string" ? name : "Pelanggan";
        })(),
        resourceIds,
        pets,
        notes: typeof row.notes === "string" && row.notes.length > 0 ? row.notes : null,
      },
    ];
  });

  const blackouts: ScheduleBlackout[] = (blackoutResult.data ?? []).flatMap((row) => {
    if (typeof row.starts_at !== "string" || typeof row.ends_at !== "string" || typeof row.resource_id !== "string") return [];
    const starts = new Date(row.starts_at);
    const ends = new Date(row.ends_at);
    const segments = splitIntoDaySegments(starts, ends, days, timeZone);
    if (segments.length === 0) return [];
    const metadata = typeof row.metadata === "object" && row.metadata !== null ? (row.metadata as Record<string, unknown>) : {};
    const structuredReason = typeof metadata.reason === "string" ? metadata.reason : null;
    return [
      {
        id: row.id,
        resourceId: row.resource_id,
        segments,
        startLabel: formatZonedTime(starts, timeZone),
        endLabel: formatZonedTime(ends, timeZone),
        reason: (typeof row.notes === "string" && row.notes.length > 0 ? row.notes : null) ?? structuredReason,
      },
    ];
  });

  // Selected groomers control which columns render, not only which bookings show.
  const resources = filtering ? branchResources.filter((resource) => appliedResourceIds.includes(resource.id)) : branchResources;

  return { branches, activeBranch, resources, branchResources, appliedResourceIds, days, bookings, blackouts, truncated };
}

export interface BookingDetailPet {
  /** grooming_job_pets.id — the identifier app.assembly_assign_pet_resource expects. */
  jobPetId: string;
  petName: string;
  status: string;
  resourceId: string | null;
  resourceName: string | null;
  services: Array<{ name: string; durationMinutes: number }>;
}

/** One booking_resources row, exactly as needed to snapshot-and-restore it. */
export interface BookingResourceSnapshot {
  resourceId: string;
  /** Postgres tstzrange literal, e.g. "[2026-01-01T09:00:00+00,2026-01-01T10:00:00+00)". */
  during: string;
  isActive: boolean;
  /**
   * Optimistic-concurrency token for this specific booking_resources row (v3 correction
   * 3). A resource mutation or its compensation must guard on this exact value, the same
   * way the `bookings` row itself is guarded on `updatedAt` above — a zero-row-affected
   * write is stale, never success, and a write must never blindly overwrite a row a
   * concurrent request has since touched.
   */
  updatedAt: string;
}

export interface BookingDetail {
  id: string;
  branchId: string;
  status: string;
  fulfillmentMode: string;
  startLabel: string;
  endLabel: string;
  dayLabel: string;
  /** Branch-local calendar date, for prefilling the reschedule form. */
  dateISO: string;
  startTime: string;
  endTime: string;
  /** Raw UTC instants, exactly as stored — the authoritative snapshot for compensation. */
  startsAtIso: string;
  endsAtIso: string;
  /**
   * Optimistic-concurrency token for the `bookings` row (Correction 2). Read fresh on
   * every load; a mutation must guard its write on this exact value and treat a
   * zero-row-affected result as a stale write, never as success.
   */
  updatedAt: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  notes: string | null;
  groomerNotes: string | null;
  pets: BookingDetailPet[];
  /** Active booking_resources rows — the assignments that currently occupy the slot. */
  activeResourceIds: string[];
  /** Released rows retained by the frozen schema; upserted rather than inserted on reuse. */
  inactiveResourceIds: string[];
  /** Full snapshot of every booking_resources row for this booking, active or not. */
  resourceAssignments: BookingResourceSnapshot[];
}

/**
 * Loads one booking's detail.
 *
 * Bound to `branchId` as well as organization and booking id: without the branch
 * predicate a membership restricted to one branch could open any booking in the
 * organization by pasting its id into the query string, because the bookings read policy
 * is organization-scoped. The resource-name lookup is scoped to the same branch.
 */
export async function loadBookingDetail(
  supabase: SupabaseClient,
  organizationId: string,
  branchId: string,
  bookingId: string,
  timeZone: string,
): Promise<BookingDetail | null> {
  const result = await supabase
    .from("bookings")
    .select(
      "id,branch_id,status,fulfillment_mode,starts_at,ends_at,notes,updated_at,customer_id,customers(display_name,phone),booking_resources(resource_id,during,is_active,updated_at),grooming_jobs(groomer_notes,grooming_job_pets(id,status,assigned_resource_id,pets(name),grooming_job_pet_services(service_name_snapshot,duration_minutes)))",
    )
    .eq("organization_id", organizationId)
    .eq("branch_id", branchId)
    .eq("id", bookingId)
    .is("deleted_at", null)
    .maybeSingle();
  assertResult("booking_detail", result.error);
  const row = result.data;
  if (!row) return null;

  const jobs = relationRows(row.grooming_jobs);
  const resourceIds = [
    ...new Set(
      jobs
        .flatMap((job) => relationRows(job.grooming_job_pets))
        .flatMap((jobPet) => (typeof jobPet.assigned_resource_id === "string" ? [jobPet.assigned_resource_id] : [])),
    ),
  ];
  const resourceNames = new Map<string, string>();
  if (resourceIds.length > 0) {
    const resources = await supabase
      .from("resources")
      .select("id,name")
      .eq("organization_id", organizationId)
      .eq("branch_id", branchId)
      .in("id", resourceIds);
    assertResult("booking_detail_resources", resources.error);
    for (const resource of resources.data ?? []) resourceNames.set(resource.id, resource.name);
  }

  const starts = new Date(row.starts_at);
  const ends = new Date(row.ends_at);
  const customer = relationRows(row.customers)[0] ?? {};
  const assignments = relationRows(row.booking_resources);
  const resourceAssignments: BookingResourceSnapshot[] = assignments.flatMap((assignment) =>
    typeof assignment.resource_id === "string" && typeof assignment.during === "string" && typeof assignment.updated_at === "string"
      ? [
          {
            resourceId: assignment.resource_id,
            during: assignment.during,
            isActive: assignment.is_active === true,
            updatedAt: assignment.updated_at,
          },
        ]
      : [],
  );
  return {
    id: row.id,
    branchId: row.branch_id,
    status: row.status,
    fulfillmentMode: row.fulfillment_mode,
    startLabel: formatZonedTime(starts, timeZone),
    endLabel: formatZonedTime(ends, timeZone),
    dayLabel: formatZonedDayLong(starts, timeZone),
    dateISO: zonedDayISO(starts, timeZone),
    startTime: formatZonedTime(starts, timeZone),
    endTime: formatZonedTime(ends, timeZone),
    startsAtIso: starts.toISOString(),
    endsAtIso: ends.toISOString(),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : starts.toISOString(),
    customerId: row.customer_id,
    customerName: typeof customer.display_name === "string" ? customer.display_name : "Pelanggan",
    customerPhone: typeof customer.phone === "string" ? customer.phone : null,
    notes: typeof row.notes === "string" && row.notes.length > 0 ? row.notes : null,
    groomerNotes: (() => {
      const value = jobs[0]?.groomer_notes;
      return typeof value === "string" && value.length > 0 ? value : null;
    })(),
    pets: jobs
      .flatMap((job) => relationRows(job.grooming_job_pets))
      .map((jobPet) => ({
        jobPetId: typeof jobPet.id === "string" ? jobPet.id : "",
        petName: (() => {
          const name = relationRows(jobPet.pets)[0]?.name;
          return typeof name === "string" ? name : "Hewan";
        })(),
        status: typeof jobPet.status === "string" ? jobPet.status : "pending",
        resourceId: typeof jobPet.assigned_resource_id === "string" ? jobPet.assigned_resource_id : null,
        resourceName: typeof jobPet.assigned_resource_id === "string" ? resourceNames.get(jobPet.assigned_resource_id) ?? null : null,
        services: relationRows(jobPet.grooming_job_pet_services).map((line) => ({
          name: typeof line.service_name_snapshot === "string" ? line.service_name_snapshot : "Layanan",
          durationMinutes: Number(line.duration_minutes) || 0,
        })),
      })),
    activeResourceIds: resourceAssignments.filter((a) => a.isActive).map((a) => a.resourceId),
    inactiveResourceIds: resourceAssignments.filter((a) => !a.isActive).map((a) => a.resourceId),
    resourceAssignments,
  };
}
