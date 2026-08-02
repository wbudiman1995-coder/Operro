import { redirect } from "next/navigation";

import { BookingShell } from "@/components/booking-shell";
import { NoOrganizationState } from "@/components/no-organization-state";
import { loadAuthContext } from "@/lib/auth-context";
import { loadBookingWorkspace } from "@/lib/bookings";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Booking" };

function mondayFor(value: string | undefined) {
  const date = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date();
  const result = Number.isFinite(date.valueOf()) ? date : new Date();
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ week?: string; created?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context) redirect("/login");
  if (context.organizations.length === 0) return <NoOrganizationState email={context.user.email ?? "akun Operro"} />;
  if (!context.activeOrganization) redirect("/organizations");
  const weekStart = mondayFor(params.week);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);
  const data = await loadBookingWorkspace(supabase, context.activeOrganization.id, weekStart.toISOString(), weekEnd.toISOString());
  return <BookingShell organizations={context.organizations} activeOrganization={context.activeOrganization} userEmail={context.user.email ?? "Akun Operro"} data={data} weekStart={weekStart} created={Boolean(params.created)} />;
}
