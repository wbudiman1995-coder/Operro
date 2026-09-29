import { NextResponse } from "next/server";
import { districtsForRegency } from "@/lib/indonesia-regions";

/** Public, immutable lookup data; no user or tenant records are exposed. */
export function GET(request: Request) {
  const regency = new URL(request.url).searchParams.get("regency") ?? "";
  if (!/^\d{2}\.\d{2}$/.test(regency)) {
    return NextResponse.json({ error: "invalid_regency" }, { status: 400 });
  }
  return NextResponse.json({ districts: districtsForRegency(regency) }, {
    headers: { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" },
  });
}
