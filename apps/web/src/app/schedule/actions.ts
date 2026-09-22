"use server";

/**
 * Batch 1B mutations.
 *
 * Every action re-derives its own facts server-side. Nothing arriving from the browser is
 * trusted: the organization comes from the verified session claim, the booking is re-read
 * scoped to that organization AND its own branch, branch access is re-resolved from
 * `branches.all` plus `membership_branch_access`, and every resource and pet identifier is
 * checked against sets loaded for that booking. Row level security enforces the same
 * boundaries again in the database.
 *
 * Error policy: expected conditions get specific, actionable Indonesian copy. Anything
 * unexpected returns a generic message and the detail goes to the server log, because
 * database messages name tables, columns, constraints and policies.
 *
 * Correction 4 (exception containment): every exported action below has its entire body
 * wrapped in try/catch. `loadBookingDetail` (and other reads under `lib/schedule.ts`)
 * throw on an unexpected database error via `assertResult`, and `loadBranchAccess` /
 * `loadCapabilities` can throw for the same reason — none of that is allowed to reach the
 * browser as a raw error. The catch blocks below are the single place that turns any such
 * throw into the same generic, non-leaking copy already used for expected-but-unexpected
 * database failures, after logging the real detail server-side.
 */
import { revalidatePath } from "next/cache";

import { loadAuthContext } from "@/lib/auth-context";
import {
  deriveActiveAssignmentWindows,
  findBlockingBooking,
  findBlockingBlackout,
  parseBlackoutInput,
  type ActiveAssignmentWindow,
  type BlackoutWindow,
  type RawBookingResourceRow,
} from "@/lib/availability";
import { loadBranchAccess, loadCapabilities, isBranchAccessible } from "@/lib/authorization";
import {
  classifyDatabaseError,
  executeReschedule,
  isCancellable,
  parseRescheduleInput,
  planAssignmentSync,
  type CompensatableStep,
  type MutationFailure,
} from "@/lib/booking-mutations";
import {
  buildActivateStep,
  buildBookingRowStep,
  buildDeactivateStep,
  buildKeepStep,
  buildPetStep,
  type RescheduleDbClient,
  type RescheduleStepContext,
} from "@/lib/reschedule-steps";
import { loadBookingDetail } from "@/lib/schedule";
import type { MutationState } from "@/lib/schedule/idle_state";
import { createClient } from "@/lib/supabase/server";
import { isValidDateISO, zonedDateTimeToUtc } from "@/lib/timezone";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GENERIC_ERROR = "Terjadi kesalahan tak terduga. Muat ulang halaman lalu coba lagi.";
const STALE_ERROR = "Data booking sudah berubah atau tidak dapat diakses. Muat ulang halaman lalu coba lagi.";
const PARTIALLY_APPLIED_ERROR =
  "Perubahan jadwal gagal di tengah proses dan pemulihan otomatis tidak dapat dipastikan berhasil sepenuhnya. Booking ini mungkin tersimpan sebagian — muat ulang halaman, periksa jadwal dan groomer booking ini dengan teliti sebelum mencoba lagi atau melanjutkan operasi lain padanya.";

const PARSE_MESSAGES: Record<string, string> = {
  invalid_date: "Tanggal tidak valid.",
  invalid_start_time: "Jam mulai tidak valid.",
  invalid_end_time: "Jam selesai tidak valid.",
  end_before_start: "Jam selesai harus setelah jam mulai.",
  invalid_fulfillment_mode: "Metode layanan tidak valid.",
  notes_too_long: "Catatan terlalu panjang.",
  pet_not_on_booking: STALE_ERROR,
  missing_groomer_assignment: "Setiap hewan wajib memiliki groomer aktif yang dipilih secara eksplisit.",
  resource_not_available_in_branch: "Groomer yang dipilih tidak aktif di cabang booking ini.",
  reason_too_long: "Alasan terlalu panjang.",
  window_too_long: "Rentang blokir terlalu panjang.",
};

function parseMessage(reason: string): string {
  if (reason.startsWith("status_not_reschedulable:")) {
    return "Booking dengan status ini tidak dapat dijadwalkan ulang.";
  }
  return PARSE_MESSAGES[reason] ?? STALE_ERROR;
}

/** Revalidates every surface whose data a booking mutation can change. */
function revalidateBookingSurfaces(customerId?: string) {
  revalidatePath("/schedule");
  revalidatePath("/bookings");
  revalidatePath("/dashboard");
  revalidatePath("/operations");
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

function parseBookingIds(value: FormDataEntryValue | null): string[] | null {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return null;
    const ids = [...new Set(parsed.filter((item): item is string => typeof item === "string" && UUID_PATTERN.test(item)))];
    return ids.length === parsed.length && ids.length >= 1 && ids.length <= 50 ? ids : null;
  } catch {
    return null;
  }
}

async function resolveWorkspace() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context?.activeOrganization) return null;
  return { supabase, organizationId: context.activeOrganization.id, membershipId: context.activeOrganization.membershipId };
}

/**
 * Loads the authoritative booking and everything needed to validate a mutation against it.
 * Returns null for a booking outside the active organization or in an inaccessible branch,
 * so both failure modes look identical from the browser.
 */
async function loadMutableBooking(bookingId: string) {
  const workspace = await resolveWorkspace();
  if (!workspace) return { ok: false as const, error: "Sesi atau workspace aktif tidak valid. Silakan masuk kembali." };
  const { supabase, organizationId, membershipId } = workspace;

  const [capabilities, branchAccess] = await Promise.all([
    loadCapabilities(supabase),
    loadBranchAccess(supabase, organizationId, membershipId),
  ]);
  if (!capabilities["booking.read"]) return { ok: false as const, error: "Anda tidak memiliki izin melihat booking." };

  // Branch is resolved from the booking row itself, then checked against real branch
  // access — the browser never tells us which branch to use.
  const head = await supabase
    .from("bookings")
    .select("id,branch_id")
    .eq("organization_id", organizationId)
    .eq("id", bookingId)
    .is("deleted_at", null)
    .maybeSingle();
  if (head.error) {
    console.error("booking_head_read_failed", head.error);
    return { ok: false as const, error: GENERIC_ERROR };
  }
  if (!head.data || !isBranchAccessible(branchAccess, head.data.branch_id)) return { ok: false as const, error: STALE_ERROR };

  const branch = await supabase
    .from("branches")
    .select("id,timezone")
    .eq("organization_id", organizationId)
    .eq("id", head.data.branch_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (branch.error || !branch.data) {
    if (branch.error) console.error("booking_branch_read_failed", branch.error);
    return { ok: false as const, error: STALE_ERROR };
  }

  const detail = await loadBookingDetail(supabase, organizationId, head.data.branch_id, bookingId, branch.data.timezone);
  if (!detail) return { ok: false as const, error: STALE_ERROR };

  const resources = await supabase
    .from("resources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("branch_id", head.data.branch_id)
    .eq("kind", "staff")
    .eq("status", "active")
    .is("deleted_at", null);
  if (resources.error) {
    console.error("booking_resources_catalog_failed", resources.error);
    return { ok: false as const, error: GENERIC_ERROR };
  }

  return {
    ok: true as const,
    supabase,
    organizationId,
    capabilities,
    detail,
    timeZone: branch.data.timezone,
    branchId: head.data.branch_id,
    branchResourceIds: new Set((resources.data ?? []).map((row) => row.id as string)),
  };
}

export async function rescheduleBookingAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const bookingId = String(formData.get("bookingId") ?? "");
    if (!UUID_PATTERN.test(bookingId)) return { error: STALE_ERROR, success: null };

    const loaded = await loadMutableBooking(bookingId);
    if (!loaded.ok) return { error: loaded.error, success: null };
    const { supabase, organizationId, capabilities, detail, timeZone, branchId, branchResourceIds } = loaded;

    // Semantic gate is booking.update. booking.create is additionally required because the
    // frozen bookings UPDATE policy is generated from the table's single write permission,
    // which is booking.create. See lib/authorization.ts for the full note.
    if (!capabilities["booking.update"]) return { error: "Anda tidak memiliki izin mengubah booking.", success: null };
    if (!capabilities["booking.create"]) {
      return {
        error:
          "Perubahan jadwal membutuhkan izin tambahan booking.create pada workspace ini karena kebijakan basis data yang berlaku. Hubungi pemilik workspace.",
        success: null,
      };
    }

    // Correction 3: every pet on the booking gets an entry in the raw map, even when the
    // browser sent an empty string or omitted the field entirely. Omitting an entry here
    // would silently resurrect the old "keep whatever was there" bug — parseRescheduleInput
    // now requires a non-empty, validated entry for every pet and rejects anything less.
    const rawPetAssignments = new Map<string, string>();
    for (const pet of detail.pets) {
      const chosen = formData.get(`resource:${pet.jobPetId}`);
      rawPetAssignments.set(pet.jobPetId, typeof chosen === "string" ? chosen : "");
    }

    const parsed = parseRescheduleInput(
      {
        dateISO: formData.get("dateISO"),
        startTime: formData.get("startTime"),
        endTime: formData.get("endTime"),
        fulfillmentMode: formData.get("fulfillmentMode"),
        notes: formData.get("notes"),
        petAssignments: rawPetAssignments,
      },
      { timeZone, branchResourceIds, bookingPetIds: new Set(detail.pets.map((pet) => pet.jobPetId)), status: detail.status },
    );
    if (!parsed.ok) return { error: parseMessage(parsed.reason), success: null };

    const desiredResourceIds = [...new Set([...parsed.value.petAssignments.values()])];
    const plan = planAssignmentSync(detail.activeResourceIds, detail.inactiveResourceIds, desiredResourceIds);
    const petChanges = new Map(
      [...parsed.value.petAssignments].filter(([jobPetId, resourceId]) => detail.pets.find((pet) => pet.jobPetId === jobPetId)?.resourceId !== resourceId),
    );

    // The authoritative snapshot for compensation, including the optimistic-concurrency
    // token (Correction 2) — read once, as part of the same `loadBookingDetail` call that
    // already produced `detail`, rather than a second re-read that could itself race.
    const original = {
      startsAt: detail.startsAtIso,
      endsAt: detail.endsAtIso,
      fulfillmentMode: detail.fulfillmentMode,
      notes: detail.notes,
    };
    const originalStatus = detail.status;
    const originalUpdatedAt = detail.updatedAt;
    const snapshotByResourceId = new Map(detail.resourceAssignments.map((assignment) => [assignment.resourceId, assignment]));
    // Plain string constants, not `parsed.value` itself: TypeScript's narrowing of
    // `parsed` to the success case does not propagate into hoisted function declarations
    // below (buildDeactivateStep, buildKeepStep, etc. — unlike the object-literal
    // closures above, which are not hoisted), so those steps read these instead.
    const targetStartsAt = parsed.value.startsAt;
    const targetEndsAt = parsed.value.endsAt;
    const during = `[${targetStartsAt},${targetEndsAt})`;

    // v4 correction 3: the concrete step builders (ownership-safe recovery per v4
    // correction 1) live in @/lib/reschedule-steps, parameterized by this context object
    // instead of closing directly over `supabase`, so they can run against an in-memory
    // fake client in tests. The cast below is the one place production code bridges the
    // real Supabase client's generated per-table types to that minimal duck-typed
    // interface — the chain shape matches at runtime even though the types don't align
    // structurally with a hand-written generic.
    const stepContext: RescheduleStepContext = {
      db: supabase as unknown as RescheduleDbClient,
      organizationId,
      branchId,
      bookingId,
      originalStatus,
      originalUpdatedAt,
      original,
      target: {
        startsAt: targetStartsAt,
        endsAt: targetEndsAt,
        fulfillmentMode: parsed.value.fulfillmentMode,
        notes: parsed.value.notes,
      },
      during,
      snapshotByResourceId,
    };

    const steps: CompensatableStep[] = [
      buildBookingRowStep(stepContext),
      ...plan.deactivate.map((resourceId) => buildDeactivateStep(stepContext, resourceId)),
      ...plan.keep.map((resourceId) => buildKeepStep(stepContext, resourceId)),
      ...plan.activate.map((resourceId) => buildActivateStep(stepContext, resourceId)),
      ...[...petChanges].map(([jobPetId, resourceId]) =>
        buildPetStep(stepContext, jobPetId, detail.pets.find((pet) => pet.jobPetId === jobPetId)?.resourceId ?? null, resourceId),
      ),
    ];

    const outcome = await executeReschedule(
      {
        async checkBlackouts(resourceIds, startsAt, endsAt) {
          if (resourceIds.length === 0) return { blockedResourceId: null, error: null };
          const result = await supabase
            .from("resource_availability")
            .select("id,resource_id,starts_at,ends_at")
            .eq("organization_id", organizationId)
            .eq("branch_id", branchId)
            .eq("kind", "blackout")
            .is("deleted_at", null)
            .not("starts_at", "is", null)
            .in("resource_id", resourceIds)
            .lt("starts_at", endsAt)
            .gt("ends_at", startsAt);
          if (result.error) return { blockedResourceId: null, error: result.error };
          const windows: BlackoutWindow[] = (result.data ?? []).flatMap((row) =>
            typeof row.starts_at === "string" && typeof row.ends_at === "string" && typeof row.resource_id === "string"
              ? [{ id: row.id, resourceId: row.resource_id, startsAt: row.starts_at, endsAt: row.ends_at }]
              : [],
          );
          const blocking = findBlockingBlackout({ resourceIds, startsAt, endsAt }, windows);
          return { blockedResourceId: blocking?.resourceId ?? null, error: null };
        },
        async recheckStatus() {
          const result = await supabase
            .from("bookings")
            .select("status")
            .eq("organization_id", organizationId)
            .eq("branch_id", branchId)
            .eq("id", bookingId)
            .is("deleted_at", null)
            .maybeSingle();
          if (result.error) return { status: null, error: result.error };
          return { status: typeof result.data?.status === "string" ? result.data.status : null, error: null };
        },
        logUnexpected(scope, error) {
          console.error(scope, error);
        },
      },
      { targetResourceIds: desiredResourceIds, startsAt: parsed.value.startsAt, endsAt: parsed.value.endsAt, steps },
    );

    switch (outcome.status) {
      case "ok":
        revalidateBookingSurfaces(detail.customerId);
        return { error: null, success: "Jadwal booking berhasil diperbarui." };
      case "slot_conflict":
        return { error: "Groomer sudah memiliki booking pada waktu tersebut. Pilih waktu atau groomer lain.", success: null };
      case "blackout":
        return { error: "Groomer diblokir (tidak tersedia) pada waktu tersebut. Hapus blokir atau pilih waktu lain.", success: null };
      case "not_authorized":
        return { error: "Izin Anda tidak mencukupi untuk menyimpan perubahan ini.", success: null };
      case "invalid_transition":
        return { error: "Status booking berubah selama proses ini dan tidak lagi mengizinkan perubahan jadwal. Muat ulang halaman.", success: null };
      case "not_found":
        return { error: STALE_ERROR, success: null };
      case "partially_applied":
        revalidateBookingSurfaces(detail.customerId);
        return { error: PARTIALLY_APPLIED_ERROR, success: null };
      default:
        return { error: GENERIC_ERROR, success: null };
    }
  } catch (error) {
    console.error("reschedule_booking_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}

export async function cancelBookingAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const bookingId = String(formData.get("bookingId") ?? "");
    if (!UUID_PATTERN.test(bookingId)) return { error: STALE_ERROR, success: null };
    // Explicit confirmation token, so a stray submit cannot cancel a booking.
    if (String(formData.get("confirm") ?? "") !== "yes") return { error: "Konfirmasi pembatalan diperlukan.", success: null };

    const loaded = await loadMutableBooking(bookingId);
    if (!loaded.ok) return { error: loaded.error, success: null };
    const { supabase, capabilities, detail } = loaded;

    if (!capabilities["booking.cancel"]) return { error: "Anda tidak memiliki izin membatalkan booking.", success: null };
    // transition_booking_status calls assert_tenant_authorized(..., 'booking.update', ...),
    // so booking.cancel alone is not sufficient for the RPC to succeed.
    if (!capabilities["booking.update"]) return { error: "Pembatalan membutuhkan izin booking.update pada workspace ini.", success: null };
    if (!isCancellable(detail.status)) return { error: "Booking dengan status ini tidak dapat dibatalkan.", success: null };

    // Delegated entirely to the frozen RPC: it owns the state machine, releases every
    // reserved package session, and its status write fires trg_bookings_release_resources
    // to release resource occupancy. Nothing is ever hard-deleted here.
    const { error } = await supabase.schema("app").rpc("transition_booking_status", { p_booking: bookingId, p_to: "canceled" });
    if (error) {
      const category = classifyDatabaseError(error);
      if (category === "unexpected") console.error("cancel_booking_failed", error);
      if (category === "invalid_transition") return { error: "Status booking tidak mengizinkan pembatalan.", success: null };
      if (category === "not_authorized") return { error: "Izin Anda tidak mencukupi untuk membatalkan booking ini.", success: null };
      if (category === "not_found") return { error: STALE_ERROR, success: null };
      return { error: GENERIC_ERROR, success: null };
    }

    revalidateBookingSurfaces(detail.customerId);
    return { error: null, success: "Booking dibatalkan. Sesi paket dan slot groomer telah dilepas." };
  } catch (error) {
    console.error("cancel_booking_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}

/** Atomic drag/drop and grouped calendar move backed by app.move_schedule_bookings. */
export async function moveScheduleBookingsAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const bookingIds = parseBookingIds(formData.get("bookingIds"));
    if (!bookingIds) return { error: "Pilih 1 sampai 50 booking yang valid.", success: null };

    const targetDateISO = String(formData.get("targetDateISO") ?? "");
    const targetMinutesInput = String(formData.get("targetMinutes") ?? "");
    const anchorBookingInput = String(formData.get("anchorBookingId") ?? bookingIds[0]);
    const anchorBookingId = UUID_PATTERN.test(anchorBookingInput) && bookingIds.includes(anchorBookingInput) ? anchorBookingInput : null;
    if (!anchorBookingId) return { error: "Booking acuan untuk pemindahan tidak valid.", success: null };
    const targetResourceInput = String(formData.get("targetResourceId") ?? "");
    const targetResourceId = targetResourceInput && UUID_PATTERN.test(targetResourceInput) ? targetResourceInput : null;
    if (targetResourceInput && !targetResourceId) return { error: "Groomer tujuan tidak valid.", success: null };
    if (targetResourceId && bookingIds.length !== 1) return { error: "Pergantian groomer hanya dapat dilakukan untuk satu booking.", success: null };

    const loaded = await loadMutableBooking(anchorBookingId);
    if (!loaded.ok) return { error: loaded.error, success: null };
    if (!loaded.capabilities["booking.update"]) return { error: "Anda tidak memiliki izin mengubah jadwal booking.", success: null };

    let deltaMinutes: number;
    if (targetDateISO || targetMinutesInput) {
      if (!isValidDateISO(targetDateISO)) return { error: "Tujuan drag booking tidak valid.", success: null };
      const targetMinutes = Number(targetMinutesInput);
      if (!Number.isInteger(targetMinutes) || targetMinutes < 0 || targetMinutes >= 1440) return { error: "Jam tujuan tidak valid.", success: null };
      const target = zonedDateTimeToUtc(targetDateISO, targetMinutes, loaded.timeZone);
      deltaMinutes = Math.round((target.getTime() - new Date(loaded.detail.startsAtIso).getTime()) / 60_000);
    } else {
      deltaMinutes = Number(formData.get("deltaMinutes"));
    }
    if (!Number.isInteger(deltaMinutes) || deltaMinutes === 0 || Math.abs(deltaMinutes) > 43_200) {
      return { error: "Pergeseran jadwal harus antara 1 menit dan 30 hari.", success: null };
    }

    const result = await loaded.supabase.schema("app").rpc("move_schedule_bookings", {
      p_bookings: bookingIds,
      p_delta_minutes: deltaMinutes,
      p_target_resource: targetResourceId,
    });
    if (result.error) {
      const message = result.error.message ?? "";
      if (/blackout|exclusion|overlap|23P01/i.test(message)) return { error: "Slot tujuan bentrok dengan booking atau waktu tidak tersedia.", success: null };
      if (/not_reschedulable|invalid_selection|selection_must_share_branch|target_resource/i.test(message)) return { error: "Pilihan booking tidak dapat dipindahkan bersama. Muat ulang kalender lalu coba lagi.", success: null };
      if (/not_authorized|42501/i.test(message)) return { error: "Izin atau akses cabang Anda tidak mencukupi.", success: null };
      console.error("move_schedule_bookings_failed", result.error);
      return { error: GENERIC_ERROR, success: null };
    }
    revalidateBookingSurfaces();
    return { error: null, success: `${bookingIds.length} booking berhasil dipindahkan.` };
  } catch (error) {
    console.error("move_schedule_bookings_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}

/** Mass cancellation retains the canonical state machine, package release, and audit trail. */
export async function cancelScheduleBookingsAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const bookingIds = parseBookingIds(formData.get("bookingIds"));
    if (!bookingIds) return { error: "Pilih 1 sampai 50 booking yang valid.", success: null };
    if (String(formData.get("confirm") ?? "") !== "yes") return { error: "Konfirmasi pembatalan diperlukan.", success: null };

    const loaded = await loadMutableBooking(bookingIds[0]);
    if (!loaded.ok) return { error: loaded.error, success: null };
    if (!loaded.capabilities["booking.cancel"] || !loaded.capabilities["booking.update"]) {
      return { error: "Izin Anda tidak mencukupi untuk membatalkan pilihan ini.", success: null };
    }
    const result = await loaded.supabase.schema("app").rpc("cancel_schedule_bookings", { p_bookings: bookingIds });
    if (result.error) {
      const message = result.error.message ?? "";
      if (/not_cancellable|invalid_transition/i.test(message)) return { error: "Salah satu booking sudah tidak dapat dibatalkan. Muat ulang kalender.", success: null };
      if (/not_authorized|42501/i.test(message)) return { error: "Izin atau akses cabang Anda tidak mencukupi.", success: null };
      console.error("cancel_schedule_bookings_failed", result.error);
      return { error: GENERIC_ERROR, success: null };
    }
    revalidateBookingSurfaces();
    return { error: null, success: `${bookingIds.length} booking dibatalkan dan seluruh slot dilepas.` };
  } catch (error) {
    console.error("cancel_schedule_bookings_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}

async function resolveBlackoutWorkspace(branchIdInput: unknown) {
  const workspace = await resolveWorkspace();
  if (!workspace) return { ok: false as const, error: "Sesi atau workspace aktif tidak valid. Silakan masuk kembali." };
  const { supabase, organizationId, membershipId } = workspace;

  const [capabilities, branchAccess] = await Promise.all([
    loadCapabilities(supabase),
    loadBranchAccess(supabase, organizationId, membershipId),
  ]);
  if (!capabilities["resource.manage"]) return { ok: false as const, error: "Anda tidak memiliki izin mengelola ketersediaan groomer." };

  const branchId = typeof branchIdInput === "string" && UUID_PATTERN.test(branchIdInput) ? branchIdInput : null;
  if (!branchId || !isBranchAccessible(branchAccess, branchId)) return { ok: false as const, error: STALE_ERROR };

  const [branch, resources] = await Promise.all([
    supabase.from("branches").select("id,timezone").eq("organization_id", organizationId).eq("id", branchId).is("deleted_at", null).maybeSingle(),
    supabase
      .from("resources")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("branch_id", branchId)
      .eq("kind", "staff")
      .eq("status", "active")
      .is("deleted_at", null),
  ]);
  if (branch.error || !branch.data || resources.error) {
    if (branch.error || resources.error) console.error("blackout_context_failed", branch.error ?? resources.error);
    return { ok: false as const, error: STALE_ERROR };
  }

  return {
    ok: true as const,
    supabase,
    organizationId,
    branchId,
    timeZone: branch.data.timezone,
    branchResourceIds: new Set((resources.data ?? []).map((row) => row.id as string)),
  };
}

/**
 * Best-effort blackout-versus-booking check.
 *
 * ADVISORY ONLY. The frozen schema has no exclusion constraint between blackouts and
 * booking assignments, so a booking moved into this window concurrently will not be
 * rejected by the database.
 */
// v3 correction 4: the authoritative window for an active assignment is `during` on
// `booking_resources` — the range the GiST exclusion constraint and the release trigger
// actually govern — never the parent booking's `starts_at`/`ends_at`, which nothing
// guarantees stays in lockstep with a specific assignment's own range. Only the parent
// booking's `deleted_at` is read off `bookings` at all, and only to exclude a soft-deleted
// booking's stale assignment rows.
async function findConflictingBooking(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  proposal: { resourceId: string; startsAt: string; endsAt: string },
): Promise<{ conflict: ActiveAssignmentWindow | null; error: MutationFailure | null }> {
  const result = await supabase
    .from("booking_resources")
    .select("booking_id,resource_id,during,is_active,bookings!inner(deleted_at)")
    .eq("organization_id", organizationId)
    .eq("resource_id", proposal.resourceId)
    .eq("is_active", true);
  if (result.error) return { conflict: null, error: result.error };

  const rows: RawBookingResourceRow[] = (result.data ?? []).map((row) => {
    const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
    const record = booking && typeof booking === "object" ? (booking as Record<string, unknown>) : null;
    return {
      bookingId: row.booking_id,
      resourceId: row.resource_id,
      during: row.during,
      isActive: row.is_active,
      bookingDeletedAt: record ? record.deleted_at : undefined,
    };
  });
  return { conflict: findBlockingBooking(proposal, deriveActiveAssignmentWindows(rows)), error: null };
}

export async function createBlackoutAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const loaded = await resolveBlackoutWorkspace(formData.get("branchId"));
    if (!loaded.ok) return { error: loaded.error, success: null };
    const { supabase, organizationId, branchId, timeZone, branchResourceIds } = loaded;

    const parsed = parseBlackoutInput(
      {
        resourceId: formData.get("resourceId"),
        dateISO: formData.get("dateISO"),
        startTime: formData.get("startTime"),
        endTime: formData.get("endTime"),
        reason: formData.get("reason"),
      },
      { timeZone, branchResourceIds },
    );
    if (!parsed.ok) return { error: parseMessage(parsed.reason), success: null };

    const conflict = await findConflictingBooking(supabase, organizationId, parsed.value);
    if (conflict.error) {
      console.error("blackout_conflict_probe_failed", conflict.error);
      return { error: GENERIC_ERROR, success: null };
    }
    if (conflict.conflict) {
      return {
        error: "Ada booking aktif pada rentang tersebut. Pindahkan booking itu lebih dulu sebelum memblokir waktu ini.",
        success: null,
      };
    }

    const { error } = await supabase.from("resource_availability").insert({
      organization_id: organizationId,
      branch_id: branchId,
      resource_id: parsed.value.resourceId,
      kind: "blackout",
      day_of_week: null,
      starts_at: parsed.value.startsAt,
      ends_at: parsed.value.endsAt,
      notes: parsed.value.reason,
      metadata: { source: "schedule_blackout", one_off: true },
    });
    if (error) {
      const category = classifyDatabaseError(error);
      if (category === "unexpected") console.error("blackout_insert_failed", error);
      if (category === "not_authorized") return { error: "Izin Anda tidak mencukupi untuk memblokir waktu groomer.", success: null };
      return { error: GENERIC_ERROR, success: null };
    }

    revalidatePath("/schedule");
    return { error: null, success: "Blokir ketersediaan ditambahkan." };
  } catch (error) {
    console.error("create_blackout_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}

export async function updateBlackoutAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const blackoutId = String(formData.get("blackoutId") ?? "");
    if (!UUID_PATTERN.test(blackoutId)) return { error: STALE_ERROR, success: null };

    const loaded = await resolveBlackoutWorkspace(formData.get("branchId"));
    if (!loaded.ok) return { error: loaded.error, success: null };
    const { supabase, organizationId, branchId, timeZone, branchResourceIds } = loaded;

    // The row is re-read scoped to org, branch and kind, so an id from another branch or
    // another availability kind cannot be edited through this action.
    const existing = await supabase
      .from("resource_availability")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("branch_id", branchId)
      .eq("kind", "blackout")
      .eq("id", blackoutId)
      .is("deleted_at", null)
      .maybeSingle();
    if (existing.error || !existing.data) {
      if (existing.error) console.error("blackout_read_failed", existing.error);
      return { error: STALE_ERROR, success: null };
    }

    const parsed = parseBlackoutInput(
      {
        resourceId: formData.get("resourceId"),
        dateISO: formData.get("dateISO"),
        startTime: formData.get("startTime"),
        endTime: formData.get("endTime"),
        reason: formData.get("reason"),
      },
      { timeZone, branchResourceIds },
    );
    if (!parsed.ok) return { error: parseMessage(parsed.reason), success: null };

    const conflict = await findConflictingBooking(supabase, organizationId, parsed.value);
    if (conflict.error) {
      console.error("blackout_conflict_probe_failed", conflict.error);
      return { error: GENERIC_ERROR, success: null };
    }
    if (conflict.conflict) {
      return { error: "Ada booking aktif pada rentang tersebut. Pindahkan booking itu lebih dulu.", success: null };
    }

    // Correction 5: confirm the row we meant to change is the row that actually changed.
    // The predicates already scope by org/branch/kind/id; `.select()` lets us tell "one
    // row matched and was updated" apart from "zero rows matched" (e.g. it was
    // concurrently soft-deleted between the read above and this write) — the latter must
    // be reported as stale, never as success.
    const result = await supabase
      .from("resource_availability")
      .update({
        resource_id: parsed.value.resourceId,
        starts_at: parsed.value.startsAt,
        ends_at: parsed.value.endsAt,
        day_of_week: null,
        notes: parsed.value.reason,
      })
      .eq("organization_id", organizationId)
      .eq("branch_id", branchId)
      .eq("kind", "blackout")
      .eq("id", blackoutId)
      .is("deleted_at", null)
      .select("id");
    if (result.error) {
      const category = classifyDatabaseError(result.error);
      if (category === "unexpected") console.error("blackout_update_failed", result.error);
      if (category === "not_authorized") return { error: "Izin Anda tidak mencukupi untuk mengubah blokir ini.", success: null };
      return { error: GENERIC_ERROR, success: null };
    }
    if (!result.data || result.data.length !== 1) return { error: STALE_ERROR, success: null };

    revalidatePath("/schedule");
    return { error: null, success: "Blokir ketersediaan diperbarui." };
  } catch (error) {
    console.error("update_blackout_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}

export async function removeBlackoutAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const blackoutId = String(formData.get("blackoutId") ?? "");
    if (!UUID_PATTERN.test(blackoutId)) return { error: STALE_ERROR, success: null };
    if (String(formData.get("confirm") ?? "") !== "yes") return { error: "Konfirmasi penghapusan diperlukan.", success: null };

    const loaded = await resolveBlackoutWorkspace(formData.get("branchId"));
    if (!loaded.ok) return { error: loaded.error, success: null };
    const { supabase, organizationId, branchId } = loaded;

    // Soft delete: resource_availability carries deleted_at and is audited, and Batch 1A
    // schedule reads already filter `deleted_at is null`, so the block disappears from the
    // calendar without destroying the audited row.
    //
    // Correction 5: same row-count verification as the update action above — zero rows
    // affected (already removed, or never existed under this org/branch/kind) is reported
    // as stale, never silently treated as "removed successfully".
    const result = await supabase
      .from("resource_availability")
      .update({ deleted_at: new Date().toISOString() })
      .eq("organization_id", organizationId)
      .eq("branch_id", branchId)
      .eq("kind", "blackout")
      .eq("id", blackoutId)
      .is("deleted_at", null)
      .select("id");
    if (result.error) {
      const category = classifyDatabaseError(result.error);
      if (category === "unexpected") console.error("blackout_delete_failed", result.error);
      if (category === "not_authorized") return { error: "Izin Anda tidak mencukupi untuk menghapus blokir ini.", success: null };
      return { error: GENERIC_ERROR, success: null };
    }
    if (!result.data || result.data.length !== 1) return { error: STALE_ERROR, success: null };

    revalidatePath("/schedule");
    return { error: null, success: "Blokir ketersediaan dihapus." };
  } catch (error) {
    console.error("remove_blackout_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}

export async function createBranchBlockAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const loaded = await resolveBlackoutWorkspace(formData.get("branchId"));
    if (!loaded.ok) return { error: loaded.error, success: null };
    const dateISO = String(formData.get("dateISO") ?? "");
    const startTime = String(formData.get("startTime") ?? "");
    const endTime = String(formData.get("endTime") ?? "");
    const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
    if (!isValidDateISO(dateISO) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) return { error: "Tanggal atau waktu penutupan tidak valid.", success: null };
    const startMinutes = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3));
    const endMinutes = Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3));
    if (endMinutes <= startMinutes) return { error: "Waktu selesai harus setelah waktu mulai.", success: null };
    const startsAt = zonedDateTimeToUtc(dateISO, startMinutes, loaded.timeZone).toISOString();
    const endsAt = zonedDateTimeToUtc(dateISO, endMinutes, loaded.timeZone).toISOString();
    const result = await loaded.supabase.from("branch_availability_blocks").insert({ organization_id: loaded.organizationId, branch_id: loaded.branchId, starts_at: startsAt, ends_at: endsAt, reason: reason || null, metadata: { source: "schedule_branch_block" } });
    if (result.error) {
      if (/branch_block_booking_conflict|23P01/i.test(result.error.message)) return { error: "Cabang masih memiliki booking aktif pada waktu tersebut.", success: null };
      console.error("branch_block_insert_failed", result.error); return { error: GENERIC_ERROR, success: null };
    }
    revalidatePath("/schedule"); revalidatePath("/bookings");
    return { error: null, success: "Penutupan seluruh cabang ditambahkan." };
  } catch (error) { console.error("create_branch_block_unexpected", error); return { error: GENERIC_ERROR, success: null }; }
}

export async function removeBranchBlockAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const id = String(formData.get("blockId") ?? "");
    if (!UUID_PATTERN.test(id) || String(formData.get("confirm") ?? "") !== "yes") return { error: "Konfirmasi penutupan tidak valid.", success: null };
    const loaded = await resolveBlackoutWorkspace(formData.get("branchId")); if (!loaded.ok) return { error: loaded.error, success: null };
    const result = await loaded.supabase.from("branch_availability_blocks").update({ deleted_at: new Date().toISOString() }).eq("organization_id", loaded.organizationId).eq("branch_id", loaded.branchId).eq("id", id).is("deleted_at", null).select("id");
    if (result.error || result.data?.length !== 1) return { error: STALE_ERROR, success: null };
    revalidatePath("/schedule"); return { error: null, success: "Penutupan cabang dihapus dari kalender." };
  } catch (error) { console.error("remove_branch_block_unexpected", error); return { error: GENERIC_ERROR, success: null }; }
}

export async function createServedCityDateAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const loaded = await resolveBlackoutWorkspace(formData.get("branchId")); if (!loaded.ok) return { error: loaded.error, success: null };
    const serviceDate = String(formData.get("serviceDate") ?? "");
    const city = String(formData.get("city") ?? "").trim().slice(0, 120);
    const notes = String(formData.get("notes") ?? "").trim().slice(0, 500);
    if (!isValidDateISO(serviceDate) || city.length < 2) return { error: "Tanggal dan kota layanan wajib diisi.", success: null };
    const result = await loaded.supabase.from("branch_served_city_dates").insert({ organization_id: loaded.organizationId, branch_id: loaded.branchId, service_date: serviceDate, kabupaten_kota: city, notes: notes || null });
    if (result.error) { if (/duplicate|23505/i.test(result.error.message)) return { error: "Kota tersebut sudah dijadwalkan pada tanggal ini.", success: null }; console.error("served_city_insert_failed", result.error); return { error: GENERIC_ERROR, success: null }; }
    revalidatePath("/schedule"); revalidatePath("/bookings"); return { error: null, success: "Kota layanan harian ditambahkan." };
  } catch (error) { console.error("create_served_city_unexpected", error); return { error: GENERIC_ERROR, success: null }; }
}

export async function removeServedCityDateAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const id = String(formData.get("servedCityId") ?? "");
    if (!UUID_PATTERN.test(id) || String(formData.get("confirm") ?? "") !== "yes") return { error: "Konfirmasi kota layanan tidak valid.", success: null };
    const loaded = await resolveBlackoutWorkspace(formData.get("branchId")); if (!loaded.ok) return { error: loaded.error, success: null };
    const result = await loaded.supabase.from("branch_served_city_dates").update({ deleted_at: new Date().toISOString() }).eq("organization_id", loaded.organizationId).eq("branch_id", loaded.branchId).eq("id", id).is("deleted_at", null).select("id");
    if (result.error || result.data?.length !== 1) return { error: STALE_ERROR, success: null };
    revalidatePath("/schedule"); return { error: null, success: "Kota layanan dihapus dari tanggal tersebut." };
  } catch (error) { console.error("remove_served_city_unexpected", error); return { error: GENERIC_ERROR, success: null }; }
}

export async function createBookingSeriesAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const bookingId = String(formData.get("bookingId") ?? "");
    const frequency = String(formData.get("frequency") ?? "");
    const occurrences = Number(formData.get("occurrences"));
    const conflictMode = String(formData.get("conflictMode") ?? "skip");
    if (!UUID_PATTERN.test(bookingId)) return { error: STALE_ERROR, success: null };
    if (!["weekly", "biweekly", "monthly"].includes(frequency)) return { error: "Frekuensi jadwal tidak valid.", success: null };
    if (!Number.isInteger(occurrences) || occurrences < 2 || occurrences > 52) return { error: "Jumlah pertemuan harus antara 2 dan 52.", success: null };
    if (!["skip", "stop", "next_available"].includes(conflictMode)) return { error: "Aturan bentrok tidak valid.", success: null };

    const supabase = await createClient();
    const auth = await loadAuthContext(supabase);
    if (!auth?.activeOrganizationId) return { error: "Sesi Anda berakhir. Silakan masuk kembali.", success: null };
    const result = await supabase.schema("app").rpc("create_booking_series", {
      p_template_booking: bookingId,
      p_frequency: frequency,
      p_occurrences: occurrences,
      p_conflict_mode: conflictMode,
    });
    if (result.error) {
      const message = result.error.message ?? "";
      if (/booking_already_in_series/i.test(message)) return { error: "Booking ini sudah menjadi bagian dari seri rutin.", success: null };
      if (/exclusion|overlap|23P01/i.test(message)) return { error: "Ada jadwal groomer yang bentrok. Pilih mode lewati bentrok atau ubah jadwal awal.", success: null };
      if (/not_authorized|42501/i.test(message)) return { error: "Izin Anda tidak mencukupi untuk membuat seri booking.", success: null };
      console.error("create_booking_series_failed", result.error);
      return { error: GENERIC_ERROR, success: null };
    }
    const payload = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    const created = Number(payload.created_count ?? 0);
    const skipped = Array.isArray(payload.skipped_sequences) ? payload.skipped_sequences.length : 0;
    const alternatives = payload.alternative_minutes && typeof payload.alternative_minutes === "object" && !Array.isArray(payload.alternative_minutes)
      ? Object.keys(payload.alternative_minutes as Record<string, unknown>).length
      : 0;
    revalidatePath("/schedule");
    revalidatePath("/bookings");
    return { error: null, success: `Seri rutin dibuat: ${created} booking${alternatives ? `, ${alternatives} dipindah ke waktu alternatif` : ""}${skipped ? `, ${skipped} jadwal bentrok dilewati` : ""}.` };
  } catch (error) {
    console.error("create_booking_series_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}

export async function cancelBookingSeriesAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const bookingId = String(formData.get("bookingId") ?? "");
    const scope = String(formData.get("scope") ?? "current");
    if (!UUID_PATTERN.test(bookingId)) return { error: STALE_ERROR, success: null };
    if (!["current", "future", "all"].includes(scope)) return { error: "Cakupan pembatalan tidak valid.", success: null };
    if (String(formData.get("confirm") ?? "") !== "yes") return { error: "Konfirmasi pembatalan diperlukan.", success: null };

    const loaded = await loadMutableBooking(bookingId);
    if (!loaded.ok) return { error: loaded.error, success: null };
    if (!loaded.capabilities["booking.cancel"] || !loaded.capabilities["booking.update"]) return { error: "Izin Anda tidak mencukupi untuk membatalkan seri ini.", success: null };
    if (!loaded.detail.seriesId && scope !== "current") return { error: "Booking ini bukan bagian dari seri rutin.", success: null };

    const result = await loaded.supabase.schema("app").rpc("cancel_booking_series_scope", { p_booking: bookingId, p_scope: scope });
    if (result.error) {
      const message = result.error.message ?? "";
      if (/invalid_scope|booking_not_in_series/i.test(message)) return { error: "Cakupan seri berubah. Muat ulang kalender.", success: null };
      if (/invalid_transition/i.test(message)) return { error: "Salah satu booking tidak lagi dapat dibatalkan. Muat ulang kalender.", success: null };
      if (/not_authorized|42501/i.test(message)) return { error: "Izin atau akses cabang Anda tidak mencukupi.", success: null };
      console.error("cancel_booking_series_failed", result.error);
      return { error: GENERIC_ERROR, success: null };
    }
    const payload = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    const canceled = Number(payload.canceled_count ?? 0);
    revalidateBookingSurfaces(loaded.detail.customerId);
    return { error: null, success: `${canceled} booking rutin dibatalkan. Sesi paket dan slot groomer telah dilepas.` };
  } catch (error) {
    console.error("cancel_booking_series_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}

export async function replaceWeeklyAvailabilityAction(_previous: MutationState, formData: FormData): Promise<MutationState> {
  try {
    const resourceId = String(formData.get("resourceId") ?? "");
    if (!UUID_PATTERN.test(resourceId)) return { error: "Pilih groomer yang valid.", success: null };
    let windows: unknown;
    try { windows = JSON.parse(String(formData.get("windows") ?? "[]")); } catch { return { error: "Jadwal mingguan tidak valid.", success: null }; }
    if (!Array.isArray(windows) || windows.length > 14) return { error: "Jadwal mingguan tidak valid.", success: null };
    for (const window of windows) {
      if (!window || typeof window !== "object") return { error: "Jadwal mingguan tidak valid.", success: null };
      const item = window as Record<string, unknown>;
      if (!Number.isInteger(item.dayOfWeek) || Number(item.dayOfWeek) < 0 || Number(item.dayOfWeek) > 6 || !/^\d{2}:\d{2}$/.test(String(item.startTime)) || !/^\d{2}:\d{2}$/.test(String(item.endTime)) || String(item.endTime) <= String(item.startTime)) return { error: "Pastikan setiap jam selesai berada setelah jam mulai.", success: null };
    }
    const supabase = await createClient();
    const auth = await loadAuthContext(supabase);
    if (!auth?.activeOrganizationId) return { error: "Sesi Anda berakhir. Silakan masuk kembali.", success: null };
    const result = await supabase.schema("app").rpc("replace_resource_weekly_availability", { p_resource: resourceId, p_windows: windows });
    if (result.error) {
      if (/not_authorized|42501/i.test(result.error.message)) return { error: "Izin Anda tidak mencukupi untuk mengubah jadwal groomer.", success: null };
      console.error("replace_weekly_availability_failed", result.error);
      return { error: GENERIC_ERROR, success: null };
    }
    revalidatePath("/schedule");
    revalidatePath("/bookings");
    return { error: null, success: `${Number(result.data ?? windows.length)} rentang kerja mingguan disimpan.` };
  } catch (error) {
    console.error("replace_weekly_availability_unexpected", error);
    return { error: GENERIC_ERROR, success: null };
  }
}
