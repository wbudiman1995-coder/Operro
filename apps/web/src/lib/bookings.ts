import type { SupabaseClient } from "@supabase/supabase-js";

export interface BranchOption { id: string; name: string; timezone: string }
export interface CustomerOption { id: string; name: string; phone: string | null }
export interface PetOption { id: string; customerId: string; name: string; breed: string | null }
export interface ServiceOption { id: string; name: string; durationMinutes: number; basePrice: number; currency: string }
export interface ResourceOption { id: string; branchId: string; name: string }
export interface BookingListItem {
  id: string;
  branchId: string;
  customerName: string;
  petNames: string[];
  startsAt: string;
  endsAt: string;
  status: string;
  fulfillmentMode: string;
}
export interface BookingWorkspaceData {
  branches: BranchOption[];
  customers: CustomerOption[];
  pets: PetOption[];
  services: ServiceOption[];
  resources: ResourceOption[];
  bookings: BookingListItem[];
}

function fail(scope: string, message: string) {
  throw new Error(`${scope}_failed:${message}`);
}

export async function loadBookingWorkspace(
  supabase: SupabaseClient,
  organizationId: string,
  from: string,
  to: string,
): Promise<BookingWorkspaceData> {
  const [branchResult, customerResult, petResult, serviceResult, resourceResult, bookingResult] = await Promise.all([
    supabase.from("branches").select("id,name,timezone").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("customers").select("id,display_name,phone").eq("organization_id", organizationId).in("status", ["lead", "active"]).is("deleted_at", null).order("display_name"),
    supabase.from("pets").select("id,customer_id,name,breed").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("service_catalog").select("id,name,duration_minutes,base_price,currency").eq("organization_id", organizationId).eq("is_active", true).is("deleted_at", null).order("name"),
    supabase.from("resources").select("id,branch_id,name").eq("organization_id", organizationId).eq("kind", "staff").eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("bookings").select("id,branch_id,customer_id,starts_at,ends_at,status,fulfillment_mode").eq("organization_id", organizationId).gte("starts_at", from).lt("starts_at", to).is("deleted_at", null).order("starts_at"),
  ]);

  for (const [scope, result] of [["branches", branchResult], ["customers", customerResult], ["pets", petResult], ["services", serviceResult], ["resources", resourceResult], ["bookings", bookingResult]] as const) {
    if (result.error) fail(scope, result.error.message);
  }

  const bookingRows = bookingResult.data ?? [];
  const bookingIds = bookingRows.map((row) => row.id);
  const petNamesByBooking = new Map<string, string[]>();
  if (bookingIds.length > 0) {
    const { data: jobPets, error } = await supabase.from("grooming_job_pets").select("grooming_job_id,pets!inner(name)").in("grooming_job_id", bookingIds).is("deleted_at", null);
    if (error) fail("booking_pets", error.message);
    for (const row of jobPets ?? []) {
      const related = Array.isArray(row.pets) ? row.pets[0] : row.pets;
      const name = related && typeof related === "object" && "name" in related ? String(related.name) : null;
      if (name) petNamesByBooking.set(row.grooming_job_id, [...(petNamesByBooking.get(row.grooming_job_id) ?? []), name]);
    }
  }
  const customers = (customerResult.data ?? []).map((row) => ({ id: row.id, name: row.display_name, phone: row.phone }));
  const customerNames = new Map(customers.map((customer) => [customer.id, customer.name]));

  return {
    branches: (branchResult.data ?? []).map((row) => ({ id: row.id, name: row.name, timezone: row.timezone })),
    customers,
    pets: (petResult.data ?? []).map((row) => ({ id: row.id, customerId: row.customer_id, name: row.name, breed: row.breed })),
    services: (serviceResult.data ?? []).map((row) => ({ id: row.id, name: row.name, durationMinutes: row.duration_minutes, basePrice: Number(row.base_price), currency: row.currency })),
    resources: (resourceResult.data ?? []).map((row) => ({ id: row.id, branchId: row.branch_id, name: row.name })),
    bookings: bookingRows.map((row) => ({
      id: row.id,
      branchId: row.branch_id,
      customerName: customerNames.get(row.customer_id) ?? "Pelanggan",
      petNames: petNamesByBooking.get(row.id) ?? [],
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      fulfillmentMode: row.fulfillment_mode,
    })),
  };
}
