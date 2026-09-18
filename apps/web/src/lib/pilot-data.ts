/**
 * Function index:
 * - loadDashboardData: aggregates live daily KPIs and upcoming work.
 * - loadCustomerWorkspace: loads customers, pets, and package balances.
 * - loadTaskWorkspace: loads branch-scoped tasks.
 * - loadOperationsWorkspace: loads grooming jobs and pet execution state.
 * - loadCatalogWorkspace: loads services, groomers, packages, products, and stock.
 * - loadFinanceWorkspace: loads invoices, payments, and expenses.
 * - loadReportWorkspace: aggregates the current month's operating report.
 * - loadPayrollWorkspace: loads staff base pay + accrued commission for a period, and any existing run.
 * - loadMyScheduleWorkspace: loads the current user's own assigned, incomplete grooming jobs.
 * - loadLeaderboardWorkspace: ranks staff by dogs groomed and commission earned this month.
 * - loadFollowupWorkspace: finds customers whose pets are overdue for grooming.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

function assertResult(scope: string, error: { message: string } | null) {
  if (error) throw new Error(`${scope}_failed:${error.message}`);
}

function relationRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}

function embeddedCustomerName(value: unknown) {
  const name = relationRows(value)[0]?.display_name;
  return typeof name === "string" ? name : "Pelanggan";
}

function embeddedPetNames(value: unknown) {
  return relationRows(value).flatMap((job) => relationRows(job.grooming_job_pets)).flatMap((jobPet) => {
    const name = relationRows(jobPet.pets)[0]?.name;
    return typeof name === "string" ? [name] : [];
  });
}

export function formatRupiah(value: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
}

export interface DashboardData {
  bookingToday: number;
  revenueToday: number;
  activeCustomers: number;
  openTasks: number;
  upcoming: Array<{ id: string; startsAt: string; status: string; customerName: string; petNames: string[] }>;
}

export async function loadDashboardData(supabase: SupabaseClient, organizationId: string): Promise<DashboardData> {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const upcomingEnd = new Date(start); upcomingEnd.setDate(upcomingEnd.getDate() + 7);
  const [bookingCount, customerCount, taskCount, paymentRows, bookingRows] = await Promise.all([
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).gte("starts_at", start.toISOString()).lt("starts_at", end.toISOString()).not("status", "in", "(canceled,no_show)").is("deleted_at", null),
    supabase.from("customers").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null),
    supabase.from("tasks").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).in("status", ["todo", "in_progress"]).is("deleted_at", null),
    supabase.from("payments").select("amount").eq("organization_id", organizationId).eq("status", "succeeded").gte("paid_at", start.toISOString()).lt("paid_at", end.toISOString()),
    supabase.from("bookings").select("id,starts_at,status,customers(display_name),grooming_jobs(grooming_job_pets(pets(name)))").eq("organization_id", organizationId).gte("starts_at", now.toISOString()).lt("starts_at", upcomingEnd.toISOString()).not("status", "in", "(canceled,no_show)").is("deleted_at", null).order("starts_at").limit(6),
  ]);
  for (const [scope, result] of [["dashboard_bookings", bookingCount], ["dashboard_customers", customerCount], ["dashboard_tasks", taskCount], ["dashboard_payments", paymentRows], ["dashboard_upcoming", bookingRows]] as const) assertResult(scope, result.error);
  return {
    bookingToday: bookingCount.count ?? 0,
    revenueToday: (paymentRows.data ?? []).reduce((sum, row) => sum + Number(row.amount), 0),
    activeCustomers: customerCount.count ?? 0,
    openTasks: taskCount.count ?? 0,
    upcoming: (bookingRows.data ?? []).map((row) => ({ id: row.id, startsAt: row.starts_at, status: row.status, customerName: embeddedCustomerName(row.customers), petNames: embeddedPetNames(row.grooming_jobs) })),
  };
}

export interface CustomerWorkspace {
  customers: Array<{
    id: string; name: string; phone: string | null; status: string; source: string | null; notes: string | null;
    pets: Array<{ id: string; name: string; species: string; breed: string | null; temperament: string | null }>;
    packages: Array<{ name: string; remaining: number; expiresAt: string | null }>;
    addresses: Array<{ id: string; label: string; formattedLine: string; latitude: number | null; longitude: number | null; isDefault: boolean }>;
  }>;
}

export async function loadCustomerWorkspace(supabase: SupabaseClient, organizationId: string): Promise<CustomerWorkspace> {
  const [customers, pets, customerPackages, packages, addresses] = await Promise.all([
    supabase.from("customers").select("id,display_name,phone,status,source,notes").eq("organization_id", organizationId).is("deleted_at", null).order("display_name"),
    supabase.from("pets").select("id,customer_id,name,species,breed,temperament").eq("organization_id", organizationId).is("deleted_at", null).order("name"),
    supabase.from("customer_packages").select("customer_id,package_id,sessions_remaining,expires_at,status").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null),
    supabase.from("packages").select("id,name").eq("organization_id", organizationId).is("deleted_at", null),
    supabase.from("customer_addresses").select("id,customer_id,label,line1,line2,kecamatan,kabupaten_kota,province,postal_code,latitude,longitude,is_default").eq("organization_id", organizationId).is("deleted_at", null).order("is_default", { ascending: false }),
  ]);
  for (const [scope, result] of [["customers", customers], ["pets", pets], ["customer_packages", customerPackages], ["packages", packages], ["customer_addresses", addresses]] as const) assertResult(scope, result.error);
  const packageMap = new Map((packages.data ?? []).map((row) => [row.id, row.name]));
  return { customers: (customers.data ?? []).map((customer) => ({
    id: customer.id, name: customer.display_name, phone: customer.phone, status: customer.status, source: customer.source, notes: customer.notes,
    pets: (pets.data ?? []).filter((pet) => pet.customer_id === customer.id).map((pet) => ({ id: pet.id, name: pet.name, species: pet.species, breed: pet.breed, temperament: pet.temperament })),
    packages: (customerPackages.data ?? []).filter((item) => item.customer_id === customer.id).map((item) => ({ name: packageMap.get(item.package_id) ?? "Paket", remaining: item.sessions_remaining, expiresAt: item.expires_at })),
    addresses: (addresses.data ?? []).filter((address) => address.customer_id === customer.id).map((address) => ({
      id: address.id,
      label: address.label,
      formattedLine: [address.line1, address.line2, address.kecamatan, address.kabupaten_kota, address.province, address.postal_code].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(", "),
      latitude: address.latitude === null ? null : Number(address.latitude),
      longitude: address.longitude === null ? null : Number(address.longitude),
      isDefault: address.is_default,
    })),
  })) };
}

export interface TaskWorkspace {
  branches: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; title: string; branchName: string; status: string; priority: string; dueAt: string | null }>;
}

export async function loadTaskWorkspace(supabase: SupabaseClient, organizationId: string): Promise<TaskWorkspace> {
  const [branches, tasks] = await Promise.all([
    supabase.from("branches").select("id,name").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null).order("name"),
    supabase.from("tasks").select("id,branch_id,title,status,priority,due_at").eq("organization_id", organizationId).is("deleted_at", null).order("due_at", { nullsFirst: false }),
  ]);
  assertResult("task_branches", branches.error); assertResult("tasks", tasks.error);
  const branchMap = new Map((branches.data ?? []).map((row) => [row.id, row.name]));
  return { branches: branches.data ?? [], tasks: (tasks.data ?? []).map((task) => ({ id: task.id, title: task.title, branchName: branchMap.get(task.branch_id) ?? "Cabang", status: task.status, priority: task.priority, dueAt: task.due_at })) };
}

export interface OperationsWorkspace {
  jobs: Array<{ id: string; startsAt: string; status: string; mode: string; customerName: string; checklist: Record<string, boolean>; groomerNotes: string | null; invoiceNumber: string | null; pets: Array<{ id: string; name: string; status: string; groomer: string; services: string[] }> }>;
}

export async function loadOperationsWorkspace(supabase: SupabaseClient, organizationId: string): Promise<OperationsWorkspace> {
  const from = new Date(); from.setDate(from.getDate() - 1); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 8);
  const bookings = await supabase.from("bookings").select("id,customer_id,starts_at,status,fulfillment_mode").eq("organization_id", organizationId).gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString()).not("status", "in", "(canceled,no_show)").is("deleted_at", null).order("starts_at");
  assertResult("operations_bookings", bookings.error);
  const bookingIds = (bookings.data ?? []).map((row) => row.id);
  if (!bookingIds.length) return { jobs: [] };
  const customerIds = [...new Set((bookings.data ?? []).map((row) => row.customer_id))];
  const [customers, jobPets, resources, groomingJobs, orders] = await Promise.all([
    supabase.from("customers").select("id,display_name").in("id", customerIds),
    supabase.from("grooming_job_pets").select("id,grooming_job_id,pet_id,assigned_resource_id,status").in("grooming_job_id", bookingIds).is("deleted_at", null),
    supabase.from("resources").select("id,name").eq("organization_id", organizationId).is("deleted_at", null),
    supabase.from("grooming_jobs").select("booking_id,checklist,groomer_notes").eq("organization_id", organizationId).in("booking_id", bookingIds),
    supabase.from("orders").select("id,booking_id").eq("organization_id", organizationId).in("booking_id", bookingIds).is("deleted_at", null),
  ]);
  assertResult("operations_customers", customers.error); assertResult("operations_pets", jobPets.error); assertResult("operations_resources", resources.error); assertResult("operations_jobs", groomingJobs.error); assertResult("operations_orders", orders.error);
  const petIds = [...new Set((jobPets.data ?? []).map((row) => row.pet_id))];
  const jobPetIds = (jobPets.data ?? []).map((row) => row.id);
  const orderIds = (orders.data ?? []).map((row) => row.id);
  const [pets, lines, invoices] = await Promise.all([
    petIds.length ? supabase.from("pets").select("id,name").in("id", petIds) : Promise.resolve({ data: [], error: null }),
    jobPetIds.length ? supabase.from("grooming_job_pet_services").select("grooming_job_pet_id,service_name_snapshot").in("grooming_job_pet_id", jobPetIds).is("deleted_at", null) : Promise.resolve({ data: [], error: null }),
    orderIds.length ? supabase.from("invoices").select("order_id,invoice_number").eq("organization_id", organizationId).in("order_id", orderIds) : Promise.resolve({ data: [], error: null }),
  ]);
  assertResult("operations_pet_names", pets.error); assertResult("operations_lines", lines.error); assertResult("operations_invoices", invoices.error);
  const customerMap = new Map((customers.data ?? []).map((row) => [row.id, row.display_name]));
  const petMap = new Map((pets.data ?? []).map((row) => [row.id, row.name]));
  const resourceMap = new Map((resources.data ?? []).map((row) => [row.id, row.name]));
  return { jobs: (bookings.data ?? []).map((booking) => { const job = (groomingJobs.data ?? []).find((item) => item.booking_id === booking.id); const order = (orders.data ?? []).find((item) => item.booking_id === booking.id); const invoice = order ? (invoices.data ?? []).find((item) => item.order_id === order.id) : null; return { id: booking.id, startsAt: booking.starts_at, status: booking.status, mode: booking.fulfillment_mode, customerName: customerMap.get(booking.customer_id) ?? "Pelanggan", checklist: (job?.checklist && typeof job.checklist === "object" ? job.checklist : {}) as Record<string, boolean>, groomerNotes: job?.groomer_notes ?? null, invoiceNumber: invoice?.invoice_number ?? null, pets: (jobPets.data ?? []).filter((pet) => pet.grooming_job_id === booking.id).map((pet) => ({ id: pet.id, name: petMap.get(pet.pet_id) ?? "Hewan", status: pet.status, groomer: resourceMap.get(pet.assigned_resource_id) ?? "Belum ditugaskan", services: (lines.data ?? []).filter((line) => line.grooming_job_pet_id === pet.id).map((line) => line.service_name_snapshot) })) }; }) };
}

export interface CatalogWorkspace {
  branches: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string; duration: number; price: number; active: boolean }>;
  resources: Array<{ id: string; name: string; branchName: string; status: string; skills: unknown }>;
  packages: Array<{ id: string; name: string; sessions: number; price: number; active: boolean }>;
  products: Array<{ id: string; name: string; sku: string | null; stock: number }>;
}

export async function loadCatalogWorkspace(supabase: SupabaseClient, organizationId: string): Promise<CatalogWorkspace> {
  const [branches, services, resources, packages, products, levels] = await Promise.all([
    supabase.from("branches").select("id,name").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null),
    supabase.from("service_catalog").select("id,name,duration_minutes,base_price,is_active").eq("organization_id", organizationId).is("deleted_at", null).order("name"),
    supabase.from("resources").select("id,branch_id,name,status,skills").eq("organization_id", organizationId).eq("kind", "staff").is("deleted_at", null).order("name"),
    supabase.from("packages").select("id,name,total_sessions,price,is_active").eq("organization_id", organizationId).is("deleted_at", null).order("name"),
    supabase.from("product_catalog").select("id,name,sku").eq("organization_id", organizationId).is("deleted_at", null).order("name"),
    supabase.from("inventory_levels").select("product_id,quantity").eq("organization_id", organizationId),
  ]);
  for (const [scope, result] of [["catalog_branches", branches], ["catalog_services", services], ["catalog_resources", resources], ["catalog_packages", packages], ["catalog_products", products], ["catalog_levels", levels]] as const) assertResult(scope, result.error);
  const branchMap = new Map((branches.data ?? []).map((row) => [row.id, row.name]));
  const stock = new Map<string, number>(); for (const row of levels.data ?? []) stock.set(row.product_id, (stock.get(row.product_id) ?? 0) + Number(row.quantity));
  return { branches: branches.data ?? [], services: (services.data ?? []).map((row) => ({ id: row.id, name: row.name, duration: row.duration_minutes, price: Number(row.base_price), active: row.is_active })), resources: (resources.data ?? []).map((row) => ({ id: row.id, name: row.name, branchName: branchMap.get(row.branch_id) ?? "Cabang", status: row.status, skills: row.skills })), packages: (packages.data ?? []).map((row) => ({ id: row.id, name: row.name, sessions: row.total_sessions, price: Number(row.price), active: row.is_active })), products: (products.data ?? []).map((row) => ({ id: row.id, name: row.name, sku: row.sku, stock: stock.get(row.id) ?? 0 })) };
}

export interface FinanceWorkspace {
  invoices: Array<{ id: string; number: string; customerName: string; total: number; status: string; issuedAt: string }>;
  payments: Array<{ id: string; method: string; amount: number; status: string; paidAt: string }>;
  expenses: Array<{ id: string; description: string; category: string | null; amount: number; status: string; incurredAt: string }>;
}

export async function loadFinanceWorkspace(supabase: SupabaseClient, organizationId: string): Promise<FinanceWorkspace> {
  const [invoices, payments, expenses, customers] = await Promise.all([
    supabase.from("invoices").select("id,invoice_number,customer_id,total,status,issued_at").eq("organization_id", organizationId).order("issued_at", { ascending: false }).limit(50),
    supabase.from("payments").select("id,method,amount,status,paid_at").eq("organization_id", organizationId).order("paid_at", { ascending: false }).limit(50),
    supabase.from("expenses").select("id,description,category,amount,status,incurred_at").eq("organization_id", organizationId).is("deleted_at", null).order("incurred_at", { ascending: false }).limit(50),
    supabase.from("customers").select("id,display_name").eq("organization_id", organizationId).is("deleted_at", null),
  ]);
  for (const [scope, result] of [["finance_invoices", invoices], ["finance_payments", payments], ["finance_expenses", expenses], ["finance_customers", customers]] as const) assertResult(scope, result.error);
  const customerMap = new Map((customers.data ?? []).map((row) => [row.id, row.display_name]));
  return { invoices: (invoices.data ?? []).map((row) => ({ id: row.id, number: row.invoice_number, customerName: customerMap.get(row.customer_id) ?? "Pelanggan", total: Number(row.total), status: row.status, issuedAt: row.issued_at })), payments: (payments.data ?? []).map((row) => ({ id: row.id, method: row.method, amount: Number(row.amount), status: row.status, paidAt: row.paid_at })), expenses: (expenses.data ?? []).map((row) => ({ id: row.id, description: row.description, category: row.category, amount: Number(row.amount), status: row.status, incurredAt: row.incurred_at })) };
}

export async function loadReportWorkspace(supabase: SupabaseClient, organizationId: string) {
  const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
  const [bookings, payments, expenses] = await Promise.all([
    supabase.from("bookings").select("status,fulfillment_mode").eq("organization_id", organizationId).gte("starts_at", start.toISOString()).is("deleted_at", null),
    supabase.from("payments").select("amount,method,status").eq("organization_id", organizationId).gte("paid_at", start.toISOString()),
    supabase.from("expenses").select("amount,status").eq("organization_id", organizationId).gte("incurred_at", start.toISOString().slice(0, 10)).is("deleted_at", null),
  ]);
  assertResult("report_bookings", bookings.error); assertResult("report_payments", payments.error); assertResult("report_expenses", expenses.error);
  const revenue = (payments.data ?? []).filter((row) => row.status === "succeeded").reduce((sum, row) => sum + Number(row.amount), 0);
  const expense = (expenses.data ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
  const completed = (bookings.data ?? []).filter((row) => row.status === "completed").length;
  const canceled = (bookings.data ?? []).filter((row) => ["canceled", "no_show"].includes(row.status)).length;
  const methodTotals = new Map<string, number>(); for (const row of payments.data ?? []) if (row.status === "succeeded") methodTotals.set(row.method, (methodTotals.get(row.method) ?? 0) + Number(row.amount));
  return { revenue, expense, net: revenue - expense, totalBookings: (bookings.data ?? []).length, completed, canceled, completionRate: (bookings.data ?? []).length ? Math.round(completed / (bookings.data ?? []).length * 100) : 0, methodTotals: [...methodTotals.entries()].map(([method, total]) => ({ method, total })) };
}

function embeddedStaffName(value: unknown) {
  const user = relationRows(relationRows(value)[0]?.users)[0];
  const name = user?.full_name ?? user?.email;
  return typeof name === "string" && name.length > 0 ? name : "Staf";
}

// No hours-worked/attendance table exists in this schema, so hourly pay_type cannot be
// computed from real hours worked — base_amount is used as-is for every pay_type.
export interface PayrollWorkspace {
  run: { id: string; status: string; totalGross: number; totalNet: number } | null;
  staff: Array<{ membershipId: string; name: string; basePay: number; commissionTotal: number; grossPay: number; currency: string }>;
}

export async function loadPayrollWorkspace(supabase: SupabaseClient, organizationId: string, periodStart: string, periodEnd: string): Promise<PayrollWorkspace> {
  const [staff, commissions, run] = await Promise.all([
    supabase.from("staff_compensation").select("membership_id,base_amount,currency,memberships(users(email,full_name))").eq("organization_id", organizationId).eq("is_active", true).is("deleted_at", null),
    supabase.from("commission_entries").select("membership_id,commission_amount").eq("organization_id", organizationId).eq("status", "accrued").gte("occurred_at", periodStart).lt("occurred_at", periodEnd),
    supabase.from("payroll_runs").select("id,status,total_gross,total_net").eq("organization_id", organizationId).eq("period_start", periodStart).eq("period_end", periodEnd).maybeSingle(),
  ]);
  assertResult("payroll_staff", staff.error); assertResult("payroll_commissions", commissions.error); assertResult("payroll_run", run.error);
  const commissionByMembership = new Map<string, number>(); for (const row of commissions.data ?? []) commissionByMembership.set(row.membership_id, (commissionByMembership.get(row.membership_id) ?? 0) + Number(row.commission_amount));
  return {
    run: run.data ? { id: run.data.id, status: run.data.status, totalGross: Number(run.data.total_gross), totalNet: Number(run.data.total_net) } : null,
    staff: (staff.data ?? []).map((row) => { const basePay = Number(row.base_amount); const commissionTotal = commissionByMembership.get(row.membership_id) ?? 0; return { membershipId: row.membership_id, name: embeddedStaffName(row.memberships), basePay, commissionTotal, grossPay: Math.round((basePay + commissionTotal) * 100) / 100, currency: row.currency }; }),
  };
}

export interface MyScheduleJob {
  groomingJobPetId: string;
  bookingId: string;
  startsAt: string;
  customerName: string;
  customerPhone: string | null;
  petName: string;
  services: string[];
  status: string;
  fulfillmentMode: string;
  dispatchStage: string | null;
  evidence: Array<{ id: string; category: string; filename: string; url: string; createdAt: string }>;
  stylingReferences: Array<{ id: string; petId: string; filename: string; caption: string | null; url: string; expiresAt: string; createdAt: string }>;
  /** Immutable booking-time snapshot — never the customer's current saved address. */
  address: { formattedLine: string; landmark: string | null; accessNotes: string | null; mapsUrl: string } | null;
}

function readAddressSnapshot(value: unknown): MyScheduleJob["address"] {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const line1 = typeof row.line1 === "string" ? row.line1 : "";
  if (!line1) return null;
  const parts = [line1, row.line2, row.kecamatan, row.kabupaten_kota, row.province, row.postal_code].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  const formattedLine = parts.join(", ");
  const latitude = typeof row.latitude === "number" ? row.latitude : null;
  const longitude = typeof row.longitude === "number" ? row.longitude : null;
  const mapsUrl = latitude !== null && longitude !== null
    ? `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formattedLine)}`;
  return {
    formattedLine,
    landmark: typeof row.landmark === "string" ? row.landmark : null,
    accessNotes: typeof row.access_notes === "string" ? row.access_notes : null,
    mapsUrl,
  };
}

export async function loadMyScheduleWorkspace(supabase: SupabaseClient, organizationId: string, userId: string): Promise<MyScheduleJob[]> {
  const membership = await supabase.from("memberships").select("id").eq("organization_id", organizationId).eq("user_id", userId).eq("status", "active").is("deleted_at", null).maybeSingle();
  assertResult("my_schedule_membership", membership.error); if (!membership.data) return [];
  const resources = await supabase.from("resources").select("id").eq("organization_id", organizationId).eq("membership_id", membership.data.id).is("deleted_at", null);
  assertResult("my_schedule_resources", resources.error); const resourceIds = (resources.data ?? []).map((row) => row.id); if (!resourceIds.length) return [];

  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 8);
  const bookings = await supabase.from("bookings").select("id,starts_at,fulfillment_mode,dispatch_stage,address_snapshot,customers(display_name,phone)").eq("organization_id", organizationId).gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString()).not("status", "in", "(canceled,no_show)").is("deleted_at", null).order("starts_at");
  assertResult("my_schedule_bookings", bookings.error); const bookingIds = (bookings.data ?? []).map((row) => row.id); if (!bookingIds.length) return [];

  const gjps = await supabase.from("grooming_job_pets").select("id,grooming_job_id,pet_id,status").in("assigned_resource_id", resourceIds).in("grooming_job_id", bookingIds).neq("status", "complete").is("deleted_at", null);
  assertResult("my_schedule_gjps", gjps.error); if (!(gjps.data ?? []).length) return [];
  const petIds = [...new Set((gjps.data ?? []).map((row) => row.pet_id))]; const gjpIds = (gjps.data ?? []).map((row) => row.id);
  const [pets, lines, evidenceLinks, stylingLinks] = await Promise.all([
    supabase.from("pets").select("id,name").eq("organization_id", organizationId).in("id", petIds),
    supabase.from("grooming_job_pet_services").select("grooming_job_pet_id,service_name_snapshot").eq("organization_id", organizationId).in("grooming_job_pet_id", gjpIds).is("deleted_at", null),
    supabase.from("attachment_links").select("attachment_id,subject_id").eq("organization_id", organizationId).eq("subject_type", "booking").in("subject_id", bookingIds),
    supabase.from("attachment_links").select("attachment_id,subject_id").eq("organization_id", organizationId).eq("subject_type", "pet").in("subject_id", petIds),
  ]);
  assertResult("my_schedule_pets", pets.error); assertResult("my_schedule_lines", lines.error); assertResult("my_schedule_evidence_links", evidenceLinks.error); assertResult("my_schedule_styling_links", stylingLinks.error);
  const attachmentIds = [...new Set((evidenceLinks.data ?? []).map((link) => link.attachment_id))];
  const evidenceResult = attachmentIds.length > 0
    ? await supabase.from("attachments").select("id,storage_bucket,storage_path,filename,metadata,created_at").eq("organization_id", organizationId).in("id", attachmentIds).is("deleted_at", null)
    : { data: [], error: null };
  assertResult("my_schedule_evidence", evidenceResult.error);
  const bookingByAttachment = new Map((evidenceLinks.data ?? []).map((link) => [link.attachment_id, link.subject_id]));
  const evidenceByPetJob = new Map<string, MyScheduleJob["evidence"]>();
  await Promise.all((evidenceResult.data ?? []).map(async (attachment) => {
    const metadata = typeof attachment.metadata === "object" && attachment.metadata !== null && !Array.isArray(attachment.metadata) ? attachment.metadata as Record<string, unknown> : {};
    const petJobId = typeof metadata.grooming_job_pet_id === "string" ? metadata.grooming_job_pet_id : null;
    if (!petJobId || !gjpIds.includes(petJobId) || bookingByAttachment.get(attachment.id) === undefined) return;
    const signed = await supabase.storage.from(attachment.storage_bucket).createSignedUrl(attachment.storage_path, 3600);
    if (signed.error || !signed.data?.signedUrl) return;
    const items = evidenceByPetJob.get(petJobId) ?? [];
    items.push({ id: attachment.id, category: typeof metadata.category === "string" ? metadata.category : "other", filename: attachment.filename, url: signed.data.signedUrl, createdAt: attachment.created_at });
    evidenceByPetJob.set(petJobId, items);
  }));
  const stylingAttachmentIds = [...new Set((stylingLinks.data ?? []).map((link) => link.attachment_id))];
  const stylingResult = stylingAttachmentIds.length > 0
    ? await supabase.from("attachments").select("id,storage_bucket,storage_path,filename,metadata,created_at").eq("organization_id", organizationId).in("storage_bucket", ["styling-references", "onboarding-styling"]).in("id", stylingAttachmentIds).is("deleted_at", null)
    : { data: [], error: null };
  assertResult("my_schedule_styling_references", stylingResult.error);
  const petByStylingAttachment = new Map((stylingLinks.data ?? []).map((link) => [link.attachment_id, link.subject_id]));
  const stylingByPet = new Map<string, MyScheduleJob["stylingReferences"]>();
  await Promise.all((stylingResult.data ?? []).map(async (attachment) => {
    const metadata = typeof attachment.metadata === "object" && attachment.metadata !== null && !Array.isArray(attachment.metadata) ? attachment.metadata as Record<string, unknown> : {};
    const petId = petByStylingAttachment.get(attachment.id); const expiresAt = typeof metadata.expires_at === "string" ? metadata.expires_at : "";
    if (!petId || metadata.kind !== "styling_reference" || !expiresAt || Date.parse(expiresAt) <= Date.now()) return;
    const signed = await supabase.storage.from(attachment.storage_bucket).createSignedUrl(attachment.storage_path, 1800);
    if (signed.error || !signed.data?.signedUrl) return;
    const items = stylingByPet.get(petId) ?? [];
    items.push({ id: attachment.id, petId, filename: attachment.filename, caption: typeof metadata.caption === "string" && metadata.caption ? metadata.caption : null, url: signed.data.signedUrl, expiresAt, createdAt: attachment.created_at });
    stylingByPet.set(petId, items);
  }));
  const bookingMap = new Map((bookings.data ?? []).map((row) => [row.id, row])); const petMap = new Map((pets.data ?? []).map((row) => [row.id, row.name]));
  const servicesByGjp = new Map<string, string[]>(); for (const row of lines.data ?? []) { const arr = servicesByGjp.get(row.grooming_job_pet_id) ?? []; arr.push(row.service_name_snapshot); servicesByGjp.set(row.grooming_job_pet_id, arr); }
  return (gjps.data ?? []).map((row) => {
    const booking = bookingMap.get(row.grooming_job_id);
    const customer = relationRows(booking?.customers)[0];
    return {
      groomingJobPetId: row.id,
      bookingId: row.grooming_job_id,
      startsAt: booking?.starts_at ?? "",
      customerName: embeddedCustomerName(booking?.customers),
      customerPhone: typeof customer?.phone === "string" ? customer.phone : null,
      petName: petMap.get(row.pet_id) ?? "Hewan",
      services: servicesByGjp.get(row.id) ?? [],
      status: row.status,
      fulfillmentMode: booking?.fulfillment_mode ?? "in_store",
      dispatchStage: booking?.dispatch_stage ?? null,
      evidence: (evidenceByPetJob.get(row.id) ?? []).sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      stylingReferences: (stylingByPet.get(row.pet_id) ?? []).sort((left,right)=>right.createdAt.localeCompare(left.createdAt)),
      address: readAddressSnapshot(booking?.address_snapshot),
    };
  }).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

// Revenue-per-groomer is deliberately not shown: an invoice is per booking, a booking can
// have multiple groomers on different pets, and this schema defines no rule for splitting
// an invoice total across them. Dogs groomed and commission earned are both cleanly
// attributable per staff member, so the leaderboard ranks on those instead.
export interface LeaderboardRow { resourceId: string; name: string; dogsGroomed: number; commissionTotal: number; currency: string }

export async function loadLeaderboardWorkspace(supabase: SupabaseClient, organizationId: string, periodStart: string, periodEnd: string): Promise<LeaderboardRow[]> {
  const resources = await supabase.from("resources").select("id,name,membership_id").eq("organization_id", organizationId).eq("kind", "staff").is("deleted_at", null);
  assertResult("leaderboard_resources", resources.error); if (!(resources.data ?? []).length) return [];

  const bookings = await supabase.from("bookings").select("id").eq("organization_id", organizationId).eq("status", "completed").gte("starts_at", periodStart).lt("starts_at", periodEnd);
  assertResult("leaderboard_bookings", bookings.error); const bookingIds = (bookings.data ?? []).map((row) => row.id);

  const dogsByResource = new Map<string, number>();
  if (bookingIds.length) {
    const gjps = await supabase.from("grooming_job_pets").select("assigned_resource_id").eq("organization_id", organizationId).eq("status", "complete").in("grooming_job_id", bookingIds).not("assigned_resource_id", "is", null);
    assertResult("leaderboard_gjps", gjps.error);
    for (const row of gjps.data ?? []) if (row.assigned_resource_id) dogsByResource.set(row.assigned_resource_id, (dogsByResource.get(row.assigned_resource_id) ?? 0) + 1);
  }

  const membershipIds = [...new Set((resources.data ?? []).map((row) => row.membership_id).filter((id): id is string => Boolean(id)))];
  const commissionByMembership = new Map<string, number>(); let currency = "IDR";
  if (membershipIds.length) {
    const commissions = await supabase.from("commission_entries").select("membership_id,commission_amount,currency").eq("organization_id", organizationId).in("membership_id", membershipIds).gte("occurred_at", periodStart).lt("occurred_at", periodEnd);
    assertResult("leaderboard_commissions", commissions.error);
    for (const row of commissions.data ?? []) { currency = row.currency; commissionByMembership.set(row.membership_id, (commissionByMembership.get(row.membership_id) ?? 0) + Number(row.commission_amount)); }
  }

  return (resources.data ?? []).map((row) => ({ resourceId: row.id, name: row.name, dogsGroomed: dogsByResource.get(row.id) ?? 0, commissionTotal: row.membership_id ? (commissionByMembership.get(row.membership_id) ?? 0) : 0, currency })).sort((a, b) => b.dogsGroomed - a.dogsGroomed);
}

// "Last groomed" comes from completed grooming_job_pets (pet-level), not bookings.pet_id —
// this vertical treats bookings.pet_id as non-authoritative (see packages/sdk's grooming
// domain model). A pet with no completed grooming at all is new, not overdue.
export interface FollowupGroup { customerId: string; customerName: string; phone: string | null; pets: Array<{ petName: string; daysSince: number }> }

export async function loadFollowupWorkspace(supabase: SupabaseClient, organizationId: string, thresholdDays = 30): Promise<FollowupGroup[]> {
  const gjps = await supabase.from("grooming_job_pets").select("grooming_job_id,pet_id").eq("organization_id", organizationId).eq("status", "complete").is("deleted_at", null);
  assertResult("followup_gjps", gjps.error); if (!(gjps.data ?? []).length) return [];

  const bookingIds = [...new Set((gjps.data ?? []).map((row) => row.grooming_job_id))];
  const bookings = await supabase.from("bookings").select("id,starts_at").eq("organization_id", organizationId).eq("status", "completed").in("id", bookingIds);
  assertResult("followup_bookings", bookings.error);
  const startsAtByBooking = new Map((bookings.data ?? []).map((row) => [row.id, row.starts_at as string]));

  const lastGroomedByPet = new Map<string, string>();
  for (const row of gjps.data ?? []) { const startsAt = startsAtByBooking.get(row.grooming_job_id); if (!startsAt) continue; const current = lastGroomedByPet.get(row.pet_id); if (!current || startsAt > current) lastGroomedByPet.set(row.pet_id, startsAt); }
  if (!lastGroomedByPet.size) return [];

  const petIds = [...lastGroomedByPet.keys()];
  const pets = await supabase.from("pets").select("id,name,customer_id").eq("organization_id", organizationId).in("id", petIds).eq("status", "active").is("deleted_at", null);
  assertResult("followup_pets", pets.error); if (!(pets.data ?? []).length) return [];

  const now = Date.now(); const thresholdMs = thresholdDays * 86_400_000;
  const overdue = (pets.data ?? []).map((pet) => { const lastGroomedAt = lastGroomedByPet.get(pet.id)!; return { pet, daysSince: Math.floor((now - new Date(lastGroomedAt).getTime()) / 86_400_000) }; }).filter((row) => row.daysSince * 86_400_000 >= thresholdMs);
  if (!overdue.length) return [];

  const customerIds = [...new Set(overdue.map((row) => row.pet.customer_id))];
  const customers = await supabase.from("customers").select("id,display_name,phone").eq("organization_id", organizationId).in("id", customerIds);
  assertResult("followup_customers", customers.error);
  const customerMap = new Map((customers.data ?? []).map((row) => [row.id, row]));

  const groups = new Map<string, FollowupGroup>();
  for (const { pet, daysSince } of overdue) {
    const customer = customerMap.get(pet.customer_id); if (!customer) continue;
    if (!groups.has(customer.id)) groups.set(customer.id, { customerId: customer.id, customerName: customer.display_name, phone: customer.phone, pets: [] });
    groups.get(customer.id)!.pets.push({ petName: pet.name, daysSince });
  }
  return [...groups.values()].sort((a, b) => Math.max(...b.pets.map((p) => p.daysSince)) - Math.max(...a.pets.map((p) => p.daysSince)));
}
