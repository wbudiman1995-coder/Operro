/**
 * Function index:
 * - loadDashboardData: aggregates live daily KPIs and upcoming work.
 * - loadCustomerWorkspace: loads customers, pets, and package balances.
 * - loadTaskWorkspace: loads branch-scoped tasks.
 * - loadOperationsWorkspace: loads grooming jobs and pet execution state.
 * - loadCatalogWorkspace: loads services, groomers, packages, products, and stock.
 * - loadFinanceWorkspace: loads invoices, payments, and expenses.
 * - loadReportWorkspace: aggregates the current month's operating report.
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
  customers: Array<{ id: string; name: string; phone: string | null; status: string; source: string | null; notes: string | null; pets: Array<{ id: string; name: string; species: string; breed: string | null; temperament: string | null }>; packages: Array<{ name: string; remaining: number; expiresAt: string | null }> }>;
}

export async function loadCustomerWorkspace(supabase: SupabaseClient, organizationId: string): Promise<CustomerWorkspace> {
  const [customers, pets, customerPackages, packages] = await Promise.all([
    supabase.from("customers").select("id,display_name,phone,status,source,notes").eq("organization_id", organizationId).is("deleted_at", null).order("display_name"),
    supabase.from("pets").select("id,customer_id,name,species,breed,temperament").eq("organization_id", organizationId).is("deleted_at", null).order("name"),
    supabase.from("customer_packages").select("customer_id,package_id,sessions_remaining,expires_at,status").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null),
    supabase.from("packages").select("id,name").eq("organization_id", organizationId).is("deleted_at", null),
  ]);
  for (const [scope, result] of [["customers", customers], ["pets", pets], ["customer_packages", customerPackages], ["packages", packages]] as const) assertResult(scope, result.error);
  const packageMap = new Map((packages.data ?? []).map((row) => [row.id, row.name]));
  return { customers: (customers.data ?? []).map((customer) => ({ id: customer.id, name: customer.display_name, phone: customer.phone, status: customer.status, source: customer.source, notes: customer.notes, pets: (pets.data ?? []).filter((pet) => pet.customer_id === customer.id).map((pet) => ({ id: pet.id, name: pet.name, species: pet.species, breed: pet.breed, temperament: pet.temperament })), packages: (customerPackages.data ?? []).filter((item) => item.customer_id === customer.id).map((item) => ({ name: packageMap.get(item.package_id) ?? "Paket", remaining: item.sessions_remaining, expiresAt: item.expires_at })) })) };
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
