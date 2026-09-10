import { NextResponse } from "next/server";

import { loadAuthContext } from "@/lib/auth-context";
import { loadCapabilities } from "@/lib/authorization";
import { loadBranchTimezones } from "@/lib/branch-context";
import { runGlobalSearch } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

/**
 * Organization-scoped search for the command palette.
 *
 * The active organization is resolved from the verified session claim, never from a query
 * parameter, so a caller cannot search another tenant by changing the request. Row level
 * security enforces the same boundary again in the database.
 *
 * Error policy: the browser only ever receives `{ error: "search_failed" }`. Database
 * messages can name tables, columns, constraints, and policies, which is reconnaissance
 * for a caller probing the schema; they stay in the server log.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!context.activeOrganization) return NextResponse.json({ error: "no_active_organization" }, { status: 409 });

  const term = new URL(request.url).searchParams.get("q");
  try {
    const organizationId = context.activeOrganization.id;
    const [capabilities, branchContext] = await Promise.all([
      loadCapabilities(supabase),
      loadBranchTimezones(supabase, organizationId),
    ]);
    const outcome = await runGlobalSearch(
      supabase,
      organizationId,
      term,
      capabilities,
      branchContext.byBranchId,
      branchContext.defaultTimezone,
    );
    if (!outcome) return NextResponse.json({ groups: [], total: 0, term: "", restrictedGroups: [] });
    return NextResponse.json(outcome, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("search_failed", error);
    return NextResponse.json({ error: "search_failed" }, { status: 500 });
  }
}
