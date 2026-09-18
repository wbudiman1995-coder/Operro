/** Google Maps coordinate parsing shared by customer forms and the server expander. */
export interface MapCoordinates {
  latitude: number;
  longitude: number;
}

function validCoordinates(latitude: number, longitude: number): MapCoordinates | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

/**
 * Accepts the formats HomePaw operators already paste: full Maps URLs, query URLs,
 * Google's !3d/!4d data form, and plain `latitude, longitude` text.
 */
export function parseMapCoordinates(value: string): MapCoordinates | null {
  const decoded = (() => {
    try { return decodeURIComponent(value.trim()); } catch { return value.trim(); }
  })();
  const patterns = [
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /!3d(-?\d+(?:\.\d+)?)[^\s]*?!4d(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|ll|query|destination)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
    /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/,
  ];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (!match) continue;
    const coordinates = validCoordinates(Number(match[1]), Number(match[2]));
    if (coordinates) return coordinates;
  }
  return null;
}

export function normalizeMapsUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isSupportedShortMapsUrl(value: string): boolean {
  const normalized = normalizeMapsUrl(value);
  if (!normalized) return false;
  const { hostname, pathname } = new URL(normalized);
  return hostname === "maps.app.goo.gl"
    || hostname === "share.google"
    || hostname === "g.co"
    || (hostname === "goo.gl" && pathname.startsWith("/maps/"));
}
