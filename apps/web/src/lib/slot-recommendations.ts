import { addDaysISO, zonedDateTimeToUtc } from "@/lib/timezone";

export interface Coordinates { latitude: number; longitude: number }
export interface AvailabilityWindow { resourceId: string; dayOfWeek: number; startMinutes: number; endMinutes: number }
export interface OccupiedWindow { resourceId: string; startsAt: string; endsAt: string; coordinates: Coordinates | null }
export interface SlotRecommendation {
  startsAt: string;
  endsAt: string;
  dateISO: string;
  startTime: string;
  endTime: string;
  travelKm: number | null;
  travelMinutes: number;
  trafficFactor: number;
  routeOrigin: "previous_stop" | "branch_base" | "unknown";
  score: number;
}

export function haversineKm(from: Coordinates, to: Coordinates): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(to.latitude - from.latitude);
  const dLon = radians(to.longitude - from.longitude);
  const lat1 = radians(from.latitude);
  const lat2 = radians(to.latitude);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function trafficFactorForMinute(minute: number): number {
  if ((minute >= 7 * 60 && minute < 10 * 60) || (minute >= 16 * 60 && minute < 19 * 60)) return 1.35;
  if (minute >= 10 * 60 && minute < 16 * 60) return 1.1;
  return 1;
}

function overlaps(startMs: number, endMs: number, otherStart: string, otherEnd: string) {
  return startMs < new Date(otherEnd).getTime() && endMs > new Date(otherStart).getTime();
}

function minuteLabel(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function recommendSlots(options: {
  fromDateISO: string;
  days?: number;
  timeZone: string;
  durationMinutes: number;
  resourceIds: readonly string[];
  availability: readonly AvailabilityWindow[];
  occupied: readonly OccupiedWindow[];
  destination: Coordinates | null;
  branchBase: Coordinates | null;
  fallbackStartMinutes?: number;
  fallbackEndMinutes?: number;
  limit?: number;
  now?: Date;
}): SlotRecommendation[] {
  const days = Math.min(14, Math.max(1, options.days ?? 7));
  const duration = Math.min(12 * 60, Math.max(30, options.durationMinutes));
  const resourceIds = [...new Set(options.resourceIds)];
  if (resourceIds.length === 0) return [];
  const results: SlotRecommendation[] = [];
  const nowMs = (options.now ?? new Date()).getTime();

  for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
    const dateISO = addDaysISO(options.fromDateISO, dayOffset);
    const [year, month, day] = dateISO.split("-").map(Number);
    const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const resourceWindows = resourceIds.map((resourceId) => {
      const configured = options.availability.filter((row) => row.resourceId === resourceId && row.dayOfWeek === dayOfWeek);
      return configured.length > 0 ? configured : [{ resourceId, dayOfWeek, startMinutes: options.fallbackStartMinutes ?? 8 * 60, endMinutes: options.fallbackEndMinutes ?? 18 * 60 }];
    });
    const commonStart = Math.max(...resourceWindows.map((rows) => Math.min(...rows.map((row) => row.startMinutes))));
    const commonEnd = Math.min(...resourceWindows.map((rows) => Math.max(...rows.map((row) => row.endMinutes))));

    for (let minute = Math.ceil(commonStart / 30) * 30; minute + duration <= commonEnd; minute += 30) {
      const starts = zonedDateTimeToUtc(dateISO, minute, options.timeZone);
      const ends = zonedDateTimeToUtc(dateISO, minute + duration, options.timeZone);
      if (starts.getTime() <= nowMs) continue;
      const blocked = options.occupied.some((row) => resourceIds.includes(row.resourceId) && overlaps(starts.getTime(), ends.getTime(), row.startsAt, row.endsAt));
      if (blocked) continue;
      const allInsideOwnWindow = resourceIds.every((resourceId) => resourceWindows[resourceIds.indexOf(resourceId)].some((row) => minute >= row.startMinutes && minute + duration <= row.endMinutes));
      if (!allInsideOwnWindow) continue;

      const previous = options.occupied
        .filter((row) => resourceIds.includes(row.resourceId) && row.coordinates && new Date(row.endsAt).getTime() <= starts.getTime())
        .sort((left, right) => new Date(right.endsAt).getTime() - new Date(left.endsAt).getTime())[0];
      const origin = previous?.coordinates ?? options.branchBase;
      const routeOrigin = previous?.coordinates ? "previous_stop" : options.branchBase ? "branch_base" : "unknown";
      const trafficFactor = trafficFactorForMinute(minute);
      const travelKm = origin && options.destination ? haversineKm(origin, options.destination) : null;
      const travelMinutes = travelKm === null ? 0 : Math.max(5, Math.round((travelKm / 24) * 60 * trafficFactor));
      const workload = options.occupied.filter((row) => resourceIds.includes(row.resourceId) && row.startsAt.slice(0, 10) === starts.toISOString().slice(0, 10)).length;
      results.push({ startsAt: starts.toISOString(), endsAt: ends.toISOString(), dateISO, startTime: minuteLabel(minute), endTime: minuteLabel(minute + duration), travelKm: travelKm === null ? null : Math.round(travelKm * 10) / 10, travelMinutes, trafficFactor, routeOrigin, score: travelMinutes * 10 + workload * 5 + dayOffset });
    }
  }
  return results.sort((left, right) => left.score - right.score || left.startsAt.localeCompare(right.startsAt)).slice(0, options.limit ?? 12);
}
