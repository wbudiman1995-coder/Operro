import "server-only";

import ExcelJS from "exceljs";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
const s = (value: unknown) => value === null || value === undefined ? "" : String(value);
export const safe = (value: unknown) => /^\s*[=+\-@]/.test(s(value)) ? `'${s(value)}` : s(value);
const code = (id: unknown) => `CUS-${s(id).slice(0, 8).toUpperCase()}`;

export async function getAll(supabase: SupabaseClient, table: string, org: string, excludeDeleted = false): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = supabase.from(table).select("*").eq("organization_id", org).order("id").range(offset, offset + 499);
    if (excludeDeleted) query = query.is("deleted_at", null);
    const result = await query;
    if (result.error) throw new Error(`${table}: ${result.error.message}`);
    rows.push(...((result.data ?? []) as Row[]));
    if ((result.data?.length ?? 0) < 500) break;
    if (offset >= 49500) throw new Error(`Too many ${table} rows for a single export`);
  }
  return rows;
}

export function sheet(book: ExcelJS.Workbook, name: string, headers: string[], rows: unknown[][]) {
  const tab = book.addWorksheet(name);
  tab.addRow(headers);
  rows.forEach((row) => tab.addRow(row.map(safe)));
  tab.getRow(1).font = { bold: true };
  tab.columns.forEach((column) => { column.width = 23; });
  tab.views = [{ state: "frozen", ySplit: 1 }];
  tab.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + headers.length)}1` };
}

export async function buildCustomerExport(supabase: SupabaseClient, org: string): Promise<ExcelJS.Workbook> {
  const [customers,pets,addresses] = await Promise.all([
    getAll(supabase,"customers",org,true), getAll(supabase,"pets",org,true), getAll(supabase,"customer_addresses",org,true),
  ]);
  const customer = new Map(customers.map((row) => [s(row.id),row]));
  const address = new Map<string,Row>();
  for (const row of addresses) if (!address.has(s(row.customer_id)) || row.is_default) address.set(s(row.customer_id),row);
  const book = new ExcelJS.Workbook(); book.creator = "Operro";
  sheet(book,"Customers",["Customer Code","Owner Name","WhatsApp","Status","Source","Address","Kecamatan","Kota","Province","Notes"],customers.map((row) => {
    const a = address.get(s(row.id));
    return [code(row.id),row.display_name,row.phone,row.status,row.source,a?.line1,a?.kecamatan,a?.kabupaten_kota,a?.province,row.notes];
  }));
  sheet(book,"Pets",["Pet Name","Species","Breed","Size","Weight Kg","Owner Name","Customer Code"],pets.map((row) =>
    [row.name,row.species,row.breed,row.size,row.weight_kg,customer.get(s(row.customer_id))?.display_name,code(row.customer_id)]));
  return book;
}

// Eight HomePaw export sections, mapped to Operro's tenant-scoped records.
export async function buildHomePawExport(supabase: SupabaseClient, org: string): Promise<ExcelJS.Workbook> {
  const [customers, pets, addresses, bookings, jobPets, invoices, manualVisits, packages, entitlements, ledger, complaints] = await Promise.all([
    getAll(supabase,"customers",org,true), getAll(supabase,"pets",org,true), getAll(supabase,"customer_addresses",org,true),
    getAll(supabase,"bookings",org,true), getAll(supabase,"grooming_job_pets",org,true), getAll(supabase,"invoices",org),
    getAll(supabase,"manual_visits",org,true), getAll(supabase,"packages",org,true),
    getAll(supabase,"customer_packages",org,true), getAll(supabase,"customer_package_ledger",org),
    getAll(supabase,"complaints",org,true),
  ]);
  const customer = new Map(customers.map((r) => [s(r.id),r]));
  const pet = new Map(pets.map((r) => [s(r.id),r]));
  const pkg = new Map(packages.map((r) => [s(r.id),r]));
  const entitlement = new Map(entitlements.map((r) => [s(r.id),r]));
  const invoice = new Map(invoices.map((r) => [s(r.id),r]));
  const address = new Map<string,Row>();
  for (const row of addresses) if (!address.has(s(row.customer_id)) || row.is_default) address.set(s(row.customer_id),row);
  const bookingPets = new Map<string,string[]>();
  for (const row of jobPets) {
    const key = s(row.grooming_job_id);
    bookingPets.set(key,[...(bookingPets.get(key) ?? []),s(pet.get(s(row.pet_id))?.name)]);
  }
  const book = new ExcelJS.Workbook(); book.creator = "Operro";
  sheet(book,"Customers",["Customer Code","Owner Name","WhatsApp","Address","Kecamatan","Kota","Province","Google Maps","Source","Notes","Created At"],customers.map((r) => {
    const a = address.get(s(r.id));
    return [code(r.id),r.display_name,r.phone,a?.line1,a?.kecamatan,a?.kabupaten_kota,a?.province,
      a?.latitude !== null && a?.latitude !== undefined && a.longitude !== null ? `https://www.google.com/maps?q=${a.latitude},${a.longitude}` : "",r.source,r.notes,r.created_at];
  }));
  sheet(book,"Pets",["Pet ID","Pet Name","Species","Owner Name","Customer Code","Breed","Size","Weight Kg","Color","Notes","Created At"],pets.map((r) =>
    [r.id,r.name,r.species,customer.get(s(r.customer_id))?.display_name,code(r.customer_id),r.breed,r.size,r.weight_kg,r.color,r.notes,r.created_at]));
  sheet(book,"Appointments",["Booking ID","Start","End","Owner Name","Pets","Mode","Service","Status","Notes"],bookings.map((r) =>
    [r.id,r.starts_at,r.ends_at,customer.get(s(r.customer_id))?.display_name,(bookingPets.get(s(r.id)) ?? []).join(", "),r.fulfillment_mode,r.service_name_snapshot,r.status,r.notes]));
  sheet(book,"Invoices",["Invoice Number","Issued At","Due At","Owner Name","Subtotal","Discount","Tax","Total","Currency","Status","Paid At"],invoices.map((r) =>
    [r.invoice_number,r.issued_at,r.due_at,customer.get(s(r.customer_id))?.display_name,r.subtotal,r.discount_total,r.tax_total,r.total,r.currency,r.status,r.paid_at]));
  sheet(book,"Visits",["Visit ID","Visit Date","Source","Owner Name","Pet","Description","Invoice Number","Notes"],[
    ...bookings.filter((r) => r.status === "completed").map((r) => [r.id,r.starts_at,"Calendar",customer.get(s(r.customer_id))?.display_name,(bookingPets.get(s(r.id)) ?? []).join(", "),r.service_name_snapshot,"",r.notes]),
    ...manualVisits.map((r) => [r.id,r.visit_at,"Manual",customer.get(s(r.customer_id))?.display_name,pet.get(s(r.pet_id))?.name,r.description,invoice.get(s(r.invoice_id))?.invoice_number,r.note]),
  ]);
  sheet(book,"Subscriptions",["Entitlement ID","Package","Owner Name","Pet","Status","Sessions Remaining","Purchased At","Expires At"],entitlements.map((r) =>
    [r.id,pkg.get(s(r.package_id))?.name,customer.get(s(r.customer_id))?.display_name,pet.get(s(r.pet_id))?.name,r.status,r.sessions_remaining,r.purchased_at,r.expires_at]));
  // HomePaw tokens correspond to Operro's immutable package-credit ledger.
  sheet(book,"Tokens",["Ledger ID","Owner Name","Package","Delta Sessions","Reason","Booking ID","Occurred At"],ledger.map((r) => {
    const e = entitlement.get(s(r.customer_package_id));
    return [r.id,customer.get(s(e?.customer_id))?.display_name,pkg.get(s(e?.package_id))?.name,r.delta,r.reason,r.reference_booking_id,r.occurred_at];
  }));
  sheet(book,"Complaints",["Reference","Reported At","Severity","Owner Name","Pet","Status","Title","Description","Resolution","Resolved At"],complaints.map((r) =>
    [r.reference_code,r.reported_at,r.severity,customer.get(s(r.customer_id))?.display_name,pet.get(s(r.pet_id))?.name,r.status,r.title,r.description,r.resolution_notes,r.resolved_at]));
  return book;
}
