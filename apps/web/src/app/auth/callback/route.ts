import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Completes an email-confirmation callback without trusting an arbitrary return URL. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/organizations";
  const invitation = /^\/accept\/([0-9a-f]{64})$/.exec(safeNext)?.[1] ?? null;

  if (code) {
    const supabase = await createClient();
    const exchange = await supabase.auth.exchangeCodeForSession(code);
    if (exchange.error) return NextResponse.redirect(new URL("/login?notice=confirmation-invalid", url.origin));

    if (invitation) {
      const claim = await supabase.schema("app").rpc("claim_access_invitation", { p_token: invitation });
      // A confirmation link may be opened again after the membership was
      // claimed. It is still safe to continue to the normal sign-in screen.
      if (claim.error && !claim.error.message.includes("membership_already_exists")) {
        await supabase.auth.signOut();
        return NextResponse.redirect(new URL("/login?notice=confirmation-incomplete", url.origin));
      }
      await supabase.auth.signOut();
      return NextResponse.redirect(new URL("/login?notice=account-confirmed", url.origin));
    }
  }

  return NextResponse.redirect(new URL(safeNext, url.origin));
}
