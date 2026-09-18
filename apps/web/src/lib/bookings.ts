import type { SupabaseClient } from "@supabase/supabase-js";

export interface BranchOption { id: string; name: string; timezone: string }
export interface CustomerOption { id: string; name: string; phone: string | null }
export interface PetOption { id: string; customerId: string; name: string; breed: string | null }
export interface ServiceOption { id: string; name: string; durationMinutes: number; basePrice: number; currency: string }
export interface ResourceOption { id: string; branchId: string; name: string }
export interface AddressOption { id: string; customerId: string; label: string; formattedLine: string; kecamatan: string | null; kabupatenKota: string | null; latitude: number | null; longitude: number | null; isDefault: boolean }
export interface ServiceAreaOption { branchId: string; kecamatan: string | null; kabupatenKota: string; travelFee: number; estimatedTravelMinutes: number }
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
  addresses: AddressOption[];
  serviceAreas: ServiceAreaOption[];
  bookings: BookingListItem[];
}

function fail(scope: string, message: string) {
  throw new Error(`${scope}_failed:${message}`);
}

function relationRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}

function embeddedPetNames(value: unknown) {
  return relationRows(value).flatMap((job) => relationRows(job.grooming_job_pets)).flatMap((jobPet) => {
    const name = relationRows(jobPet.pets)[0]?.name;
    return typeof name === "string" ? [name] : [];
  });
}

export async function loadBookingWorkspace(
  supabase: SupabaseClient,
  organizationId: string,
  from: string,
  to: string,
): Promise<BookingWorkspaceData> {
  const [branchResult, customerResult, petResult, serviceResult, resourceResult, addressResult, serviceAreaResult, bookingResult] = await Promise.all([
    supabase.from("branches").select("id,name,timezone").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("customers").select("id,display_name,phone").eq("organization_id", organizationId).in("status", ["lead", "active"]).is("deleted_at", null).order("display_name"),
    supabase.from("pets").select("id,customer_id,name,breed").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("service_catalog").select("id,name,duration_minutes,base_price,currency").eq("organization_id", organizationId).eq("is_active", true).is("deleted_at", null).order("name"),
    supabase.from("resources").select("id,branch_id,name").eq("organization_id", organizationId).eq("kind", "staff").eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("customer_addresses").select("id,customer_id,label,line1,line2,kecamatan,kabupaten_kota,province,postal_code,latitude,longitude,is_default").eq("organization_id", organizationId).is("deleted_at", null).order("is_default", { ascending: false }),
    supabase.from("branch_service_areas").select("branch_id,kecamatan,kabupaten_kota,travel_fee,estimated_travel_minutes").eq("organization_id", organizationId).eq("is_active", true).is("deleted_at", null),
    supabase.from("bookings").select("id,branch_id,customer_id,starts_at,ends_at,status,fulfillment_mode,grooming_jobs(grooming_job_pets(pets(name)))").eq("organization_id", organizationId).gte("starts_at", from).lt("starts_at", to).is("deleted_at", null).order("starts_at"),
  ]);

  for (const [scope, result] of [["branches", branchResult], ["customers", customerResult], ["pets", petResult], ["services", serviceResult], ["resources", resourceResult], ["addresses", addressResult], ["service_areas", serviceAreaResult], ["bookings", bookingResult]] as const) {
    if (result.error) fail(scope, result.error.message);
  }

  const bookingRows = bookingResult.data ?? [];
  const customers = (customerResult.data ?? []).map((row) => ({ id: row.id, name: row.display_name, phone: row.phone }));
  const customerNames = new Map(customers.map((customer) => [customer.id, customer.name]));

  return {
    branches: (branchResult.data ?? []).map((row) => ({ id: row.id, name: row.name, timezone: row.timezone })),
    customers,
    pets: (petResult.data ?? []).map((row) => ({ id: row.id, customerId: row.customer_id, name: row.name, breed: row.breed })),
    services: (serviceResult.data ?? []).map((row) => ({ id: row.id, name: row.name, durationMinutes: row.duration_minutes, basePrice: Number(row.base_price), currency: row.currency })),
    resources: (resourceResult.data ?? []).map((row) => ({ id: row.id, branchId: row.branch_id, name: row.name })),
    addresses: (addressResult.data ?? []).map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      label: row.label,
      formattedLine: [row.line1, row.line2, row.kecamatan, row.kabupaten_kota, row.province, row.postal_code].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(", "),
      kecamatan: row.kecamatan,
      kabupatenKota: row.kabupaten_kota,
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      isDefault: row.is_default,
    })),
    serviceAreas: (serviceAreaResult.data ?? []).map((row) => ({
      branchId: row.branch_id,
      kecamatan: row.kecamatan,
      kabupatenKota: row.kabupaten_kota,
      travelFee: Number(row.travel_fee),
      estimatedTravelMinutes: row.estimated_travel_minutes,
    })),
    bookings: bookingRows.map((row) => ({
      id: row.id,
      branchId: row.branch_id,
      customerName: customerNames.get(row.customer_id) ?? "Pelanggan",
      petNames: embeddedPetNames(row.grooming_jobs),
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      fulfillmentMode: row.fulfillment_mode,
    })),
  };
}
