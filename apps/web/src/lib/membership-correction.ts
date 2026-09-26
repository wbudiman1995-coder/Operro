import { isValidDateISO, zonedDayISO } from "./timezone";

const MEMBERSHIP_TIMEZONE = "Asia/Jakarta";

export function membershipExpiryDate(expiresAt: string | null): string {
  return expiresAt ? zonedDayISO(new Date(expiresAt), MEMBERSHIP_TIMEZONE) : "";
}

/** Editing another term must not silently replace the expiry's time of day. */
export function correctedMembershipExpiry(date: string, current: string | null): string | null {
  if (!date) return null;
  if (!isValidDateISO(date)) throw new Error("Tanggal kedaluwarsa tidak valid");
  if (date === membershipExpiryDate(current)) return current;
  return new Date(`${date}T23:59:59+07:00`).toISOString();
}
