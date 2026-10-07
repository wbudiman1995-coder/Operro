/**
 * Function index:
 * - ageLabelFromBirthdate: renders a human age from a birthdate.
 * - readCustomFields: surfaces free-form profile fields held in pet metadata.
 *
 * Boundary note: this module holds grooming-vertical presentation rules only. It must
 * not be imported by the vertical-neutral booking core. `packages/preset-grooming` is a
 * backend assembly package (RPC argument shaping and error classification), so it is
 * not the right home for browser-side display derivations; keeping them in one named
 * module here preserves the same separation without expanding that package's scope.
 *
 * Size labels are deliberately absent here. Tenant-owned labels and keys come
 * from the server size-band resolver and immutable grooming-line snapshots.
 */

/**
 * Calendar-accurate age. An average-month divisor is not usable here: it reports an
 * exact two-year anniversary as "1 tahun 11 bulan" because 730 days is slightly less
 * than 24 average months.
 */
export function ageLabelFromBirthdate(birthdate: string | null, now: Date = new Date()): string | null {
  if (!birthdate || !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return null;
  const [birthYear, birthMonth, birthDay] = birthdate.split("-").map(Number);
  const born = Date.UTC(birthYear, birthMonth - 1, birthDay);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (born > today) return null;

  let years = now.getUTCFullYear() - birthYear;
  let months = now.getUTCMonth() + 1 - birthMonth;
  if (now.getUTCDate() < birthDay) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years <= 0) return `${Math.max(months, 0)} bulan`;
  return months === 0 ? `${years} tahun` : `${years} tahun ${months} bulan`;
}

/**
 * Renders scalar entries from a pet's metadata as label/value pairs. Nested objects and
 * arrays are skipped rather than stringified, so an unexpected shape cannot dump raw
 * JSON into the profile.
 */
export function readCustomFields(metadata: unknown): Array<{ label: string; value: string }> {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return [];
  return Object.entries(metadata as Record<string, unknown>).flatMap(([key, value]) => {
    if (typeof value === "string" && value.trim().length > 0) return [{ label: key, value: value.trim() }];
    if (typeof value === "number" && Number.isFinite(value)) return [{ label: key, value: String(value) }];
    if (typeof value === "boolean") return [{ label: key, value: value ? "Ya" : "Tidak" }];
    return [];
  });
}

export function readMedicalFlags(flags: unknown): string[] {
  if (typeof flags !== "object" || flags === null) return [];
  if (Array.isArray(flags)) return flags.flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : []));
  return Object.entries(flags as Record<string, unknown>).flatMap(([key, value]) => {
    if (value === true) return [key];
    if (typeof value === "string" && value.trim().length > 0) return [`${key}: ${value.trim()}`];
    return [];
  });
}
