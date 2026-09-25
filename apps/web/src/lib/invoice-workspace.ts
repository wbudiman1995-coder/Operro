import type { SupabaseClient } from "@supabase/supabase-js";

function fail(scope: string, error: { message: string } | null) { if (error) throw new Error(`${scope}_failed:${error.message}`); }

export interface InvoiceStudioData {
  recentBookings: Array<{
    id: string; branchId: string; customerId: string; customerName: string; startsAt: string;
    petNames: string[]; groomerNames: string[]; serviceNames: string[]; estimatedTotal: number; searchText: string;
    pets: Array<{ id: string; name: string }>;
    serviceLines: Array<{ id: string; serviceId: string; name: string }>;
  }>;
  customers: Array<{ id: string; name: string; code: string; petNames: string[]; address: string; searchText: string }>;
  branches: Array<{ id: string; name: string }>;
  groomers: Array<{ id: string; branchId: string; name: string }>;
  packages: Array<{ id: string; name: string; sessions: number; price: number; currency: string }>;
}

export async function loadInvoiceStudioData(supabase: SupabaseClient, organizationId: string): Promise<InvoiceStudioData> {
  const from = new Date(); from.setDate(from.getDate() - 14); from.setHours(0, 0, 0, 0);
  const through = new Date(); through.setDate(through.getDate() + 1); through.setHours(23, 59, 59, 999);
  const [bookings, customers, pets, addresses, branches, groomers, packages] = await Promise.all([
    supabase.from("bookings").select("id,branch_id,customer_id,starts_at,status").eq("organization_id", organizationId).eq("status", "completed").gte("starts_at", from.toISOString()).lte("starts_at", through.toISOString()).is("deleted_at", null).order("starts_at", { ascending: false }),
    supabase.from("customers").select("id,display_name").eq("organization_id", organizationId).is("deleted_at", null).order("display_name"),
    supabase.from("pets").select("id,customer_id,name").eq("organization_id", organizationId).is("deleted_at", null).order("name"),
    supabase.from("customer_addresses").select("customer_id,line1,kecamatan,kabupaten_kota,province,is_default").eq("organization_id", organizationId).is("deleted_at", null).order("is_default", { ascending: false }),
    supabase.from("branches").select("id,name").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("resources").select("id,branch_id,name").eq("organization_id", organizationId).eq("kind", "staff").eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("packages").select("id,name,total_sessions,price,currency").eq("organization_id", organizationId).eq("is_active", true).is("deleted_at", null).order("name"),
  ]);
  for (const [scope, result] of [["invoice_bookings", bookings], ["invoice_customers", customers], ["invoice_pets", pets], ["invoice_addresses", addresses], ["invoice_branches", branches], ["invoice_groomers", groomers], ["invoice_packages", packages]] as const) fail(scope, result.error);
  const bookingIds = (bookings.data ?? []).map((row) => row.id);
  const [jobPets, orders] = await Promise.all([
    bookingIds.length ? supabase.from("grooming_job_pets").select("id,grooming_job_id,pet_id,assigned_resource_id").eq("organization_id", organizationId).in("grooming_job_id", bookingIds).is("deleted_at", null) : Promise.resolve({ data: [], error: null }),
    bookingIds.length ? supabase.from("orders").select("id,booking_id").eq("organization_id", organizationId).in("booking_id", bookingIds).is("deleted_at", null).neq("status", "canceled") : Promise.resolve({ data: [], error: null }),
  ]);
  fail("invoice_job_pets", jobPets.error); fail("invoice_orders", orders.error);
  const orderIds = (orders.data ?? []).map((row) => row.id);
  const jobPetIds = (jobPets.data ?? []).map((row) => row.id);
  const [serviceLines, invoices] = await Promise.all([
    jobPetIds.length ? supabase.from("grooming_job_pet_services").select("id,grooming_job_pet_id,service_id,service_name_snapshot,quantity,unit_price_snapshot").eq("organization_id", organizationId).in("grooming_job_pet_id", jobPetIds).is("deleted_at", null) : Promise.resolve({ data: [], error: null }),
    orderIds.length ? supabase.from("invoices").select("order_id").eq("organization_id", organizationId).in("order_id", orderIds) : Promise.resolve({ data: [], error: null }),
  ]);
  fail("invoice_service_lines", serviceLines.error); fail("invoice_existing", invoices.error);
  const invoicedOrders = new Set((invoices.data ?? []).map((row) => row.order_id));
  const invoicedBookings = new Set((orders.data ?? []).filter((row) => invoicedOrders.has(row.id)).map((row) => row.booking_id));
  const customerMap = new Map((customers.data ?? []).map((row) => [row.id, row.display_name]));
  const petMap = new Map((pets.data ?? []).map((row) => [row.id, row.name]));
  const groomerMap = new Map((groomers.data ?? []).map((row) => [row.id, row.name]));
  const customerRows = (customers.data ?? []).map((customer) => {
    const petNames = (pets.data ?? []).filter((pet) => pet.customer_id === customer.id).map((pet) => pet.name);
    const addressRow = (addresses.data ?? []).find((address) => address.customer_id === customer.id);
    const address = addressRow ? [addressRow.line1, addressRow.kecamatan, addressRow.kabupaten_kota, addressRow.province].filter(Boolean).join(", ") : "";
    const code = `CUS-${customer.id.slice(0, 8).toUpperCase()}`;
    return { id: customer.id, name: customer.display_name, code, petNames, address, searchText: [customer.display_name, code, address, ...petNames].join(" ").toLowerCase() };
  });
  return {
    recentBookings: (bookings.data ?? []).filter((booking) => !invoicedBookings.has(booking.id)).map((booking) => {
      const petRows = (jobPets.data ?? []).filter((row) => row.grooming_job_id === booking.id);
      const ids = new Set(petRows.map((row) => row.id));
      const lines = (serviceLines.data ?? []).filter((line) => ids.has(line.grooming_job_pet_id));
      const petNames = petRows.map((row) => petMap.get(row.pet_id) ?? "Hewan");
      const groomerNames = [...new Set(petRows.map((row) => row.assigned_resource_id ? groomerMap.get(row.assigned_resource_id) : null).filter((name): name is string => Boolean(name)))];
      const serviceNames = [...new Set(lines.map((line) => line.service_name_snapshot))];
      const customerName = customerMap.get(booking.customer_id) ?? "Pelanggan";
      return { id: booking.id, branchId: booking.branch_id, customerId: booking.customer_id, customerName, startsAt: booking.starts_at, petNames, groomerNames, serviceNames, pets: petRows.map((row) => ({ id: row.id, name: petMap.get(row.pet_id) ?? "Hewan" })), serviceLines: lines.filter((line) => line.service_id).map((line) => ({ id: line.id, serviceId: line.service_id!, name: line.service_name_snapshot })), estimatedTotal: lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unit_price_snapshot), 0), searchText: [customerName, booking.id, ...petNames, ...groomerNames, ...serviceNames].join(" ").toLowerCase() };
    }),
    customers: customerRows,
    branches: branches.data ?? [], groomers: (groomers.data ?? []).map((row) => ({ id: row.id, branchId: row.branch_id, name: row.name })),
    packages: (packages.data ?? []).map((pkg) => ({ id: pkg.id, name: pkg.name, sessions: pkg.total_sessions, price: Number(pkg.price), currency: pkg.currency })),
  };
}
