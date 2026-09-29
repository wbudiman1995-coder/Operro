import { isValidDateISO, zonedDateTimeToUtc } from "@/lib/timezone";

/** datetime-local is a branch wall time, not the browser or Vercel server zone. */
export function toBranchInstant(localDateTime: string, timeZone: string): string {
  const [dayISO, clock] = localDateTime.split("T");
  if (!isValidDateISO(dayISO) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock ?? "")) return localDateTime;
  const [hour, minute] = clock.split(":").map(Number);
  return zonedDateTimeToUtc(dayISO, hour * 60 + minute, timeZone).toISOString();
}

export function addWallMinutes(localDateTime: string, minutes: number): string {
  const date = new Date(`${localDateTime}:00Z`);
  if (!Number.isFinite(date.valueOf())) return "";
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString().slice(0, 16);
}
