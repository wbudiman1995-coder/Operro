import { NextResponse } from "next/server";
import { loadAuthContext } from "@/lib/auth-context";
import { isBranchAccessible, loadBranchAccess, loadCapabilities } from "@/lib/authorization";
import { recommendSlots, type Coordinates, type OccupiedWindow } from "@/lib/slot-recommendations";
import { createClient } from "@/lib/supabase/server";
import { addDaysISO, isValidDateISO, zonedDateTimeToUtc } from "@/lib/timezone";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function clockMinutes(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{2}:\d{2}/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : null;
}
function coordinates(value: unknown): Coordinates | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const latitude = Number(row.latitude ?? row.lat);
  const longitude = Number(row.longitude ?? row.lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}
function relation(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value[0] && typeof value[0] === "object" ? value[0] as Record<string, unknown> : null;
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context?.activeOrganization) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const branchId = String(body.branchId ?? "");
    const resourceIds = Array.isArray(body.resourceIds) ? [...new Set(body.resourceIds.filter((id): id is string => typeof id === "string" && UUID.test(id)))] : [];
    const durationMinutes = Number(body.durationMinutes);
    const fromDateISO = String(body.fromDateISO ?? "");
    if (!UUID.test(branchId) || resourceIds.length === 0 || resourceIds.length > 10 || !Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 720 || !isValidDateISO(fromDateISO)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

    const organizationId = context.activeOrganization.id;
    const [capabilities, branchAccess] = await Promise.all([
      loadCapabilities(supabase),
      loadBranchAccess(supabase, organizationId, context.activeOrganization.membershipId),
    ]);
    if (!capabilities["booking.create"] || !isBranchAccessible(branchAccess, branchId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const branchResult = await supabase.from("branches").select("id,timezone,settings").eq("organization_id", organizationId).eq("id", branchId).eq("status", "active").is("deleted_at", null).maybeSingle();
    if (branchResult.error || !branchResult.data) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
    const resourcesResult = await supabase.from("resources").select("id").eq("organization_id", organizationId).eq("branch_id", branchId).eq("kind", "staff").eq("status", "active").is("deleted_at", null).in("id", resourceIds);
    if (resourcesResult.error || (resourcesResult.data ?? []).length !== resourceIds.length) return NextResponse.json({ error: "invalid_resources" }, { status: 400 });

    const timeZone = branchResult.data.timezone;
    const rangeStart = zonedDateTimeToUtc(fromDateISO, 0, timeZone).toISOString();
    const rangeEnd = zonedDateTimeToUtc(addDaysISO(fromDateISO, 8), 0, timeZone).toISOString();
    const [availabilityResult, occupiedResult] = await Promise.all([
      supabase.from("resource_availability").select("resource_id,kind,day_of_week,start_time,end_time,starts_at,ends_at").eq("organization_id", organizationId).eq("branch_id", branchId).is("deleted_at", null).in("resource_id", resourceIds),
      supabase.from("booking_resources").select("resource_id,bookings!inner(starts_at,ends_at,status,address_snapshot,deleted_at)").eq("organization_id", organizationId).eq("is_active", true).in("resource_id", resourceIds).lt("bookings.starts_at", rangeEnd).gt("bookings.ends_at", rangeStart).is("bookings.deleted_at", null),
    ]);
    if (availabilityResult.error || occupiedResult.error) throw availabilityResult.error ?? occupiedResult.error;

    const occupied: OccupiedWindow[] = (occupiedResult.data ?? []).flatMap((item) => {
      const booking = relation(item.bookings);
      if (!booking || typeof booking.starts_at !== "string" || typeof booking.ends_at !== "string" || ["canceled", "no_show"].includes(String(booking.status))) return [];
      const snapshot = relation(booking.address_snapshot) ?? {};
      return [{ resourceId: item.resource_id, startsAt: booking.starts_at, endsAt: booking.ends_at, coordinates: coordinates(snapshot), city: typeof snapshot.kabupaten_kota === "string" ? snapshot.kabupaten_kota : null }];
    });
    for (const row of availabilityResult.data ?? []) {
      if (row.kind === "blackout" && typeof row.starts_at === "string" && typeof row.ends_at === "string") occupied.push({ resourceId: row.resource_id, startsAt: row.starts_at, endsAt: row.ends_at, coordinates: null });
    }
    const availability = (availabilityResult.data ?? []).flatMap((row) => {
      const startMinutes = clockMinutes(row.start_time); const endMinutes = clockMinutes(row.end_time);
      return row.kind === "available" && typeof row.day_of_week === "number" && startMinutes !== null && endMinutes !== null ? [{ resourceId: row.resource_id, dayOfWeek: row.day_of_week, startMinutes, endMinutes }] : [];
    });
    const settings = relation(branchResult.data.settings) ?? {};
    const schedule = relation(settings.schedule) ?? {};
    const branchBase = coordinates(relation(settings.location) ?? settings);
    const destination = coordinates(body.destination);
    const selectedAnchor = coordinates(body.selectedAnchor);
    const destinationCity = typeof body.destinationCity === "string" ? body.destinationCity.trim().slice(0, 120) : null;
    const slots = recommendSlots({ fromDateISO, days: 7, timeZone, durationMinutes, resourceIds, availability, occupied, destination, branchBase, selectedAnchor, destinationCity, fallbackStartMinutes: Number(schedule.dayStartMinutes) || 8 * 60, fallbackEndMinutes: Number(schedule.dayEndMinutes) || 18 * 60, limit: 12 });
    return NextResponse.json({ slots, timeZone }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("slot_recommendations_failed", error);
    return NextResponse.json({ error: "slot_recommendations_failed" }, { status: 500 });
  }
}
