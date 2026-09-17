import { redirect } from "next/navigation";

import { BookingShell } from "@/components/booking-shell";
import { NoOrganizationState } from "@/components/no-organization-state";
import { loadAuthContext } from "@/lib/auth-context";
import { loadCapabilities } from "@/lib/authorization";
import { loadBookingWorkspace } from "@/lib/bookings";
import { loadBranchTimezones } from "@/lib/branch-context";
import { mondayOf } from "@/lib/schedule-layout";
import { createClient } from "@/lib/supabase/server";
import { addDaysISO, isValidDateISO, zonedDateTimeToUtc, zonedDayISO } from "@/lib/timezone";

export const metadata = { title: "Booking" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the `customerId` preselection hint.
 *
 * The browser-supplied id is never trusted: it is re-read from `customers` scoped to the
 * active organization, so an id from another tenant resolves to undefined. The wizard then
 * simply opens unselected — no error, no "not found", nothing that would let a caller use
 * this parameter to probe which customer ids exist elsewhere.
 */
async function resolvePreselectedCustomer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  candidate: string | undefined,
): Promise<string | undefined> {
  if (!candidate || !UUID_PATTERN.test(candidate)) return undefined;
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", candidate)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return undefined;
  return data.id;
}

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ week?: string; created?: string; customerId?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context) redirect("/login");
  if (context.organizations.length === 0) return <NoOrganizationState email={context.user.email ?? "akun Operro"} />;
  if (!context.activeOrganization) redirect("/organizations");
  const organizationId = context.activeOrganization.id;

  // The week boundary carries no branch of its own, so — like every other zone-less,
  // organization-level boundary in this app (see lib/branch-context.ts) — it is resolved
  // against the explicit default-branch zone, never the server process zone (UTC on
  // Vercel). Each branch's own bookings are still bucketed and labeled in that branch's
  // own zone inside BookingShell; this only decides which Monday "this week" means.
  const { defaultTimezone } = await loadBranchTimezones(supabase, organizationId);
  const anchorISO = isValidDateISO(params.week) ? params.week : zonedDayISO(new Date(), defaultTimezone);
  const weekStartISO = mondayOf(anchorISO);
  const weekEndISO = addDaysISO(weekStartISO, 7);
  const from = zonedDateTimeToUtc(weekStartISO, 0, defaultTimezone).toISOString();
  const to = zonedDateTimeToUtc(weekEndISO, 0, defaultTimezone).toISOString();

  const [data, preselectedCustomerId, capabilities] = await Promise.all([
    loadBookingWorkspace(supabase, organizationId, from, to),
    resolvePreselectedCustomer(supabase, organizationId, params.customerId),
    loadCapabilities(supabase),
  ]);
  return <BookingShell organizations={context.organizations} activeOrganization={context.activeOrganization} userEmail={context.user.email ?? "Akun Operro"} capabilities={capabilities} data={data} weekStartISO={weekStartISO} defaultTimezone={defaultTimezone} created={Boolean(params.created)} preselectedCustomerId={preselectedCustomerId} />;
}
