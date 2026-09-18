import { NextResponse } from "next/server";

import { isSupportedShortMapsUrl, normalizeMapsUrl, parseMapCoordinates } from "@/lib/maps";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return NextResponse.json({ error: "Sesi login diperlukan." }, { status: 401 });

  const rawUrl = new URL(request.url).searchParams.get("url") ?? "";
  const normalized = normalizeMapsUrl(rawUrl);
  if (!normalized || !isSupportedShortMapsUrl(normalized)) {
    return NextResponse.json({ error: "Gunakan short link Google Maps yang valid." }, { status: 400 });
  }

  try {
    const response = await fetch(normalized, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "id-ID,id;q=0.9,en;q=0.7",
      },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const finalUrl = response.url;
    let coordinates = parseMapCoordinates(finalUrl);
    if (!coordinates) {
      const html = (await response.text()).slice(0, 2_000_000);
      const canonical = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1]
        ?? html.match(/<meta\s+[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1];
      coordinates = parseMapCoordinates(canonical ?? html);
    }
    return NextResponse.json({ expandedUrl: finalUrl, coordinates });
  } catch (error) {
    const timedOut = error instanceof Error && /timeout/i.test(`${error.name} ${error.message}`);
    return NextResponse.json(
      { error: timedOut ? "Google Maps terlalu lama merespons. Coba lagi." : "Short link Google Maps tidak dapat dibuka." },
      { status: 502 },
    );
  }
}
