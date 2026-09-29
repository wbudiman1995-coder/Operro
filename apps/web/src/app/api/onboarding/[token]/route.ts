import { NextResponse } from "next/server";
import { canonicalRegionNames } from "@/lib/indonesia-regions";
import { createClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ token: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { token } = await params;
  const supabase = await createClient();
  // Only these token-scoped public wrappers are callable by an anonymous visitor.
  // Do not grant anonymous USAGE on the entire app schema.
  const { data, error } = await supabase.rpc("get_customer_onboarding_link", { p_token: token });
  if (error) return NextResponse.json({ valid: false, status: "unavailable" }, { status: 503 });
  if (!data?.[0]) return NextResponse.json({ valid: false, status: "invalid" }, { status: 404 });
  return NextResponse.json(data[0], { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: Context) {
  try {
    const { token } = await params;
    if (Number(request.headers.get("content-length") ?? 0) > 32_768) return NextResponse.json({ error: "invalid_submission" }, { status: 413 });
    const body = await request.text();
    if (body.length > 32_768) return NextResponse.json({ error: "invalid_submission" }, { status: 413 });
    const payload = JSON.parse(body) as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.pets) || payload.pets.length < 1 || payload.pets.length > 5) {
      return NextResponse.json({ error: "invalid_submission" }, { status: 400 });
    }
    const region = canonicalRegionNames({
      province: String(payload.province ?? ""),
      kabupatenKota: String(payload.kabupatenKota ?? ""),
      kecamatan: String(payload.kecamatan ?? ""),
    });
    if (!region) return NextResponse.json({ error: "invalid_region" }, { status: 400 });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("submit_customer_onboarding", { p_token: token, p_payload: { ...payload, ...region } });
    if (error) {
      const kind = /link_expired/.test(error.message) ? "expired"
        : /link_not_available/.test(error.message) ? "used_link"
          : /invalid_(submission|pet)/.test(error.message) ? "invalid_submission" : "submit_failed";
      return NextResponse.json({ error: kind }, { status: kind === "submit_failed" ? 500 : 400 });
    }
    return NextResponse.json({ submissionId: data }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "invalid_submission" }, { status: 400 });
  }
}
