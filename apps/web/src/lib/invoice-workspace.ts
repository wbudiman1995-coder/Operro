import type { SupabaseClient } from "@supabase/supabase-js";
import { pricingBand } from "@/lib/pet-sizing";

function fail(scope: string, error: { message: string } | null) { if (error) throw new Error(`${scope}_failed:${error.message}`); }

export interface InvoiceStudioData {
  recentBookings: Array<{
    id: string; branchId: string; customerId: string; customerName: string; startsAt: string;
    petNames: string[]; groomerNames: string[]; serviceNames: string[]; estimatedTotal: number; searchText: string;
    pets: Array<{ id: string; name: string }>;
    serviceLines: Array<{ id: string; serviceId: string; name: string }>;
  }>;
  manualVisits: Array<{
    id: string; branchId: string; customerId: string; customerName: string;
    visitAt: string; description: string; petName: string | null; searchText: string;
  }>;
  customers: Array<{ id: string; name: string; code: string; petNames: string[]; pets: Array<{ id: string; name: string; band: string | null }>; address: string; searchText: string }>;
  branches: Array<{ id: string; name: string }>;
  groomers: Array<{ id: string; branchId: string; name: string }>;
  packages: Array<{ id: string; name: string; sessions: number; price: number; currency: string; perPet: boolean; sizeBand: string | null; recurrenceInterval: string }>;
}

export async function loadInvoiceStudioData(supabase: SupabaseClient, organizationId: string): Promise<InvoiceStudioData> {
  const [bookings, manualVisits, customers, pets, addresses, branches, groomers, packages] = await Promise.all([
    supabase.from("bookings").select("id,branch_id,customer_id,starts_at,status").eq("organization_id", organizationId).eq("status", "completed").is("deleted_at", null).order("starts_at", { ascending: false }).limit(1000),
    supabase.from("manual_visits").select("id,branch_id,customer_id,pet_id,visit_at,description").eq("organization_id", organizationId).is("invoice_id", null).is("deleted_at", null).order("visit_at", { ascending: false }).limit(1000),
    supabase.from("customers").select("id,display_name").eq("organization_id", organizationId).is("deleted_at", null).order("display_name"),
    supabase.from("pets").select("id,customer_id,name,species,size,weight_kg").eq("organization_id", organizationId).is("deleted_at", null).order("name"),
    supabase.from("customer_addresses").select("customer_id,line1,kecamatan,kabupaten_kota,province,is_default").eq("organization_id", organizationId).is("deleted_at", null).order("is_default", { ascending: false }),
    supabase.from("branches").select("id,name").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("resources").select("id,branch_id,name").eq("organization_id", organizationId).eq("kind", "staff").eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("packages").select("id,name,total_sessions,price,currency,per_pet,size_band,recurrence_interval").eq("organization_id", organizationId).eq("is_active", true).is("deleted_at", null).order("name"),
  ]);
  for (const [scope, result] of [["invoice_bookings", bookings], ["invoice_manual_visits", manualVisits], ["invoice_customers", customers], ["invoice_pets", pets], ["invoice_addresses", addresses], ["invoice_branches", branches], ["invoice_groomers", groomers], ["invoice_packages", packages]] as const) fail(scope, result.error);
  const bookingIds = (bookings.data ?? []).map((row) => row.id);
  const [jobPets, orders, manualBilling] = await Promise.all([
    bookingIds.length ? supabase.from("grooming_job_pets").select("id,grooming_job_id,pet_id,assigned_resource_id").eq("organization_id", organizationId).in("grooming_job_id", bookingIds).is("deleted_at", null) : Promise.resolve({ data: [], error: null }),
    bookingIds.length ? supabase.from("orders").select("id,booking_id").eq("organization_id", organizationId).in("booking_id", bookingIds).is("deleted_at", null).neq("status", "canceled") : Promise.resolve({ data: [], error: null }),
    (manualVisits.data ?? []).length ? supabase.from("visit_manual_billing").select("source_id").eq("organization_id", organizationId).eq("source_type", "manual_visit").in("source_id", (manualVisits.data ?? []).map((row) => row.id)).is("undone_at", null) : Promise.resolve({ data: [], error: null }),
  ]);
  fail("invoice_job_pets", jobPets.error); fail("invoice_orders", orders.error); fail("invoice_manual_billing", manualBilling.error);
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
  const addressMap = new Map((addresses.data ?? []).map((row) => [row.customer_id, [row.line1, row.kecamatan, row.kabupaten_kota, row.province].filter(Boolean).join(", ")]));
  const billedManualVisits = new Set((manualBilling.data ?? []).map((row) => row.source_id));
  const customerRows = (customers.data ?? []).map((customer) => {
    const customerPets = (pets.data ?? []).filter((pet) => pet.customer_id === customer.id).map((pet) => ({ id: pet.id, name: pet.name, band: pricingBand({ species: pet.species, size: pet.size, weightKg: pet.weight_kg }) }));
    const petNames = customerPets.map((pet) => pet.name);
    const addressRow = (addresses.data ?? []).find((address) => address.customer_id === customer.id);
    const address = addressRow ? [addressRow.line1, addressRow.kecamatan, addressRow.kabupaten_kota, addressRow.province].filter(Boolean).join(", ") : "";
    const code = `CUS-${customer.id.slice(0, 8).toUpperCase()}`;
    return { id: customer.id, name: customer.display_name, code, petNames, pets: customerPets, address, searchText: [customer.display_name, code, address, ...petNames].join(" ").toLowerCase() };
  });
  return {
    manualVisits: (manualVisits.data ?? []).filter((visit) => !billedManualVisits.has(visit.id)).map((visit) => {
      const customerName = customerMap.get(visit.customer_id) ?? "Pelanggan";
      const petName = visit.pet_id ? petMap.get(visit.pet_id) ?? null : null;
      return { id: visit.id, branchId: visit.branch_id, customerId: visit.customer_id, customerName,
        visitAt: visit.visit_at, description: visit.description, petName,
        searchText: [customerName, `CUS-${visit.customer_id.slice(0, 8).toUpperCase()}`, addressMap.get(visit.customer_id), petName, visit.description].filter(Boolean).join(" ").toLowerCase() };
    }),
    recentBookings: (bookings.data ?? []).filter((booking) => !invoicedBookings.has(booking.id)).map((booking) => {
      const petRows = (jobPets.data ?? []).filter((row) => row.grooming_job_id === booking.id);
      const ids = new Set(petRows.map((row) => row.id));
      const lines = (serviceLines.data ?? []).filter((line) => ids.has(line.grooming_job_pet_id));
      const petNames = petRows.map((row) => petMap.get(row.pet_id) ?? "Hewan");
      const groomerNames = [...new Set(petRows.map((row) => row.assigned_resource_id ? groomerMap.get(row.assigned_resource_id) : null).filter((name): name is string => Boolean(name)))];
      const serviceNames = [...new Set(lines.map((line) => line.service_name_snapshot))];
      const customerName = customerMap.get(booking.customer_id) ?? "Pelanggan";
      return { id: booking.id, branchId: booking.branch_id, customerId: booking.customer_id, customerName, startsAt: booking.starts_at, petNames, groomerNames, serviceNames, pets: petRows.map((row) => ({ id: row.id, name: petMap.get(row.pet_id) ?? "Hewan" })), serviceLines: lines.filter((line) => line.service_id).map((line) => ({ id: line.id, serviceId: line.service_id!, name: line.service_name_snapshot })), estimatedTotal: lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unit_price_snapshot), 0), searchText: [customerName, `CUS-${booking.customer_id.slice(0, 8).toUpperCase()}`, addressMap.get(booking.customer_id), booking.id, ...petNames, ...groomerNames, ...serviceNames].filter(Boolean).join(" ").toLowerCase() };
    }),
    customers: customerRows,
    branches: branches.data ?? [], groomers: (groomers.data ?? []).map((row) => ({ id: row.id, branchId: row.branch_id, name: row.name })),
    packages: (packages.data ?? []).map((pkg) => ({ id: pkg.id, name: pkg.name, sessions: pkg.total_sessions, price: Number(pkg.price), currency: pkg.currency, perPet: pkg.per_pet, sizeBand: pkg.size_band, recurrenceInterval: pkg.recurrence_interval })),
  };
}
