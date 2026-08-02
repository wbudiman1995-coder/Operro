"use server";

/**
 * Function index:
 * - createCustomerAction: creates a customer and optional first pet.
 * - createTaskAction / updateTaskStatusAction: manages operational tasks.
 * - transitionBookingAction / updatePetJobStatusAction: advances grooming work.
 * - updateGroomingChecklistAction / issueInvoiceForBookingAction: closes the service-to-cash loop.
 * - createServiceAction / createResourceAction: configures the operating catalog.
 * - adjustInventoryAction: appends an inventory adjustment movement.
 * - recordPaymentAction / recordExpenseAction: records manual financial activity.
 */
import "server-only";

import { revalidatePath } from "next/cache";

import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export interface PilotActionState { error: string | null; success: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedTaskStatuses = new Set(["todo", "in_progress", "done", "canceled"]);
const allowedBookingStatuses = new Set(["in_progress", "completed", "canceled", "no_show"]);
const allowedPetStatuses = new Set(["pending", "in_progress", "complete", "skipped"]);

function textValue(formData: FormData, key: string, max = 200) {
  return String(formData.get(key) ?? "").trim().slice(0, max);
}

function idValue(formData: FormData, key: string) {
  const value = textValue(formData, key, 36);
  return UUID.test(value) ? value : null;
}

function numberValue(formData: FormData, key: string) {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? value : null;
}

async function workspace() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context?.activeOrganization) return null;
  return { supabase, organizationId: context.activeOrganization.id };
}

function databaseError(scope: string, message: string) {
  return { error: `${scope}: ${message}`, success: null };
}

export async function createCustomerAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace();
  if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const name = textValue(formData, "name", 120);
  const phone = textValue(formData, "phone", 40);
  const petName = textValue(formData, "petName", 80);
  const breed = textValue(formData, "breed", 100);
  const species = textValue(formData, "species", 30) || "dog";
  if (name.length < 2) return databaseError("Pelanggan", "nama wajib diisi");
  const { data: customer, error } = await context.supabase.from("customers").insert({ organization_id: context.organizationId, display_name: name, phone: phone || null, status: "active", source: "Operro", metadata: { created_from: "homepaw_pilot" } }).select("id").single();
  if (error || !customer) return databaseError("Pelanggan gagal dibuat", error?.message ?? "unknown");
  if (petName) {
    const { error: petError } = await context.supabase.from("pets").insert({ organization_id: context.organizationId, customer_id: customer.id, name: petName, species, breed: breed || null, status: "active", metadata: { created_from: "homepaw_pilot" } });
    if (petError) {
      await context.supabase.from("customers").update({ deleted_at: new Date().toISOString() }).eq("organization_id", context.organizationId).eq("id", customer.id);
      return databaseError("Hewan gagal dibuat", petError.message);
    }
  }
  revalidatePath("/customers"); revalidatePath("/bookings"); revalidatePath("/dashboard");
  return { error: null, success: `${name} berhasil ditambahkan.` };
}

export async function createTaskAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const branchId = idValue(formData, "branchId"); const title = textValue(formData, "title", 160); const priority = textValue(formData, "priority", 20); const due = textValue(formData, "dueAt", 40);
  if (!branchId || title.length < 3 || !["low", "normal", "high", "urgent"].includes(priority)) return databaseError("Tugas", "data belum lengkap");
  const { data: branch } = await context.supabase.from("branches").select("id").eq("organization_id", context.organizationId).eq("id", branchId).eq("status", "active").maybeSingle();
  if (!branch) return databaseError("Tugas", "cabang tidak dapat diakses");
  const { error } = await context.supabase.from("tasks").insert({ organization_id: context.organizationId, branch_id: branchId, title, priority, due_at: due ? new Date(due).toISOString() : null, metadata: { created_from: "homepaw_pilot" } });
  if (error) return databaseError("Tugas gagal dibuat", error.message);
  revalidatePath("/tasks"); revalidatePath("/dashboard"); return { error: null, success: "Tugas berhasil dibuat." };
}

export async function updateTaskStatusAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const taskId = idValue(formData, "taskId"); const status = textValue(formData, "status", 30);
  if (!taskId || !allowedTaskStatuses.has(status)) return;
  await context.supabase.from("tasks").update({ status }).eq("organization_id", context.organizationId).eq("id", taskId);
  revalidatePath("/tasks"); revalidatePath("/dashboard");
}

export async function transitionBookingAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const bookingId = idValue(formData, "bookingId"); const status = textValue(formData, "status", 30);
  if (!bookingId || !allowedBookingStatuses.has(status)) return;
  await context.supabase.rpc("transition_booking_status", { p_booking: bookingId, p_to: status });
  revalidatePath("/operations"); revalidatePath("/bookings"); revalidatePath("/dashboard"); revalidatePath("/reports");
}

export async function updatePetJobStatusAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const petJobId = idValue(formData, "petJobId"); const status = textValue(formData, "status", 30);
  if (!petJobId || !allowedPetStatuses.has(status)) return;
  await context.supabase.from("grooming_job_pets").update({ status }).eq("organization_id", context.organizationId).eq("id", petJobId);
  revalidatePath("/operations");
}

export async function updateGroomingChecklistAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const bookingId = idValue(formData, "bookingId"); if (!bookingId) return;
  const checklist = { before_photo: formData.get("beforePhoto") === "on", bath: formData.get("bath") === "on", dry: formData.get("dry") === "on", finishing: formData.get("finishing") === "on", after_photo: formData.get("afterPhoto") === "on" };
  const notes = textValue(formData, "notes", 500);
  await context.supabase.from("grooming_jobs").update({ checklist, groomer_notes: notes || null }).eq("organization_id", context.organizationId).eq("booking_id", bookingId);
  revalidatePath("/operations");
}

export async function issueInvoiceForBookingAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const bookingId = idValue(formData, "bookingId"); if (!bookingId) return;
  const { data: booking } = await context.supabase.from("bookings").select("id,branch_id,customer_id,status").eq("organization_id", context.organizationId).eq("id", bookingId).eq("status", "completed").maybeSingle();
  if (!booking) return;
  const { data: existingOrders } = await context.supabase.from("orders").select("id").eq("organization_id", context.organizationId).eq("booking_id", bookingId).is("deleted_at", null);
  if ((existingOrders ?? []).length) {
    const { data: existingInvoice } = await context.supabase.from("invoices").select("id").eq("organization_id", context.organizationId).in("order_id", existingOrders!.map((row) => row.id)).limit(1).maybeSingle();
    if (existingInvoice) return;
  }
  const { data: jobPets } = await context.supabase.from("grooming_job_pets").select("id").eq("organization_id", context.organizationId).eq("grooming_job_id", bookingId).is("deleted_at", null);
  const jobPetIds = (jobPets ?? []).map((row) => row.id); if (!jobPetIds.length) return;
  const { data: lines } = await context.supabase.from("grooming_job_pet_services").select("service_id,service_name_snapshot,quantity,unit_price_snapshot,currency").eq("organization_id", context.organizationId).in("grooming_job_pet_id", jobPetIds).is("deleted_at", null);
  if (!lines?.length) return;
  const { data: order, error: orderError } = await context.supabase.from("orders").insert({ organization_id: context.organizationId, branch_id: booking.branch_id, customer_id: booking.customer_id, booking_id: booking.id, status: "confirmed", currency: "IDR", metadata: { created_from: "homepaw_pilot" } }).select("id").single();
  if (orderError || !order) return;
  const { error: itemError } = await context.supabase.from("order_items").insert(lines.map((line) => ({ organization_id: context.organizationId, order_id: order.id, item_type: "service", service_id: line.service_id, name_snapshot: line.service_name_snapshot, quantity: line.quantity, unit_price: line.unit_price_snapshot, line_total: Number(line.unit_price_snapshot) * Number(line.quantity), pricing_breakdown: { source: "grooming_job_line" }, metadata: { created_from: "homepaw_pilot" } })));
  if (itemError) { await context.supabase.from("orders").update({ status: "canceled" }).eq("id", order.id); return; }
  const { data: pricedOrder } = await context.supabase.from("orders").select("subtotal,discount_total,tax_total,total,currency").eq("organization_id", context.organizationId).eq("id", order.id).single();
  if (!pricedOrder) return;
  const invoiceNumber = `INV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${Date.now().toString().slice(-6)}`;
  const { data: invoice, error: invoiceError } = await context.supabase.from("invoices").insert({ organization_id: context.organizationId, branch_id: booking.branch_id, customer_id: booking.customer_id, order_id: order.id, invoice_number: invoiceNumber, status: "issued", currency: pricedOrder.currency, subtotal: pricedOrder.subtotal, discount_total: pricedOrder.discount_total, tax_total: pricedOrder.tax_total, total: pricedOrder.total, due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), metadata: { created_from: "homepaw_pilot", booking_id: booking.id } }).select("id").single();
  if (invoiceError || !invoice) return;
  await context.supabase.from("invoice_lines").insert(lines.map((line) => ({ organization_id: context.organizationId, invoice_id: invoice.id, item_type: "service", name_snapshot: line.service_name_snapshot, quantity: line.quantity, unit_price: line.unit_price_snapshot, line_total: Number(line.unit_price_snapshot) * Number(line.quantity), pricing_breakdown: { source: "grooming_job_line" } })));
  revalidatePath("/operations"); revalidatePath("/finance"); revalidatePath("/reports");
}

export async function createServiceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const name = textValue(formData, "name", 100); const duration = numberValue(formData, "duration"); const price = numberValue(formData, "price");
  if (name.length < 2 || !duration || duration < 15 || price === null || price < 0) return databaseError("Layanan", "nama, durasi, atau harga tidak valid");
  const { error } = await context.supabase.from("service_catalog").insert({ organization_id: context.organizationId, name, duration_minutes: duration, base_price: price, currency: "IDR", required_photos: 2, fulfillment_modes: ["home", "in_store"], metadata: { created_from: "homepaw_pilot" } });
  if (error) return databaseError("Layanan gagal dibuat", error.message);
  revalidatePath("/catalog"); revalidatePath("/bookings"); return { error: null, success: "Layanan berhasil ditambahkan." };
}

export async function createResourceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const branchId = idValue(formData, "branchId"); const name = textValue(formData, "name", 100);
  if (!branchId || name.length < 2) return databaseError("Groomer", "nama dan cabang wajib diisi");
  const { data: branch } = await context.supabase.from("branches").select("id").eq("organization_id", context.organizationId).eq("id", branchId).eq("status", "active").maybeSingle();
  if (!branch) return databaseError("Groomer", "cabang tidak dapat diakses");
  const { error } = await context.supabase.from("resources").insert({ organization_id: context.organizationId, branch_id: branchId, kind: "staff", name, capacity: 1, skills: ["grooming"], status: "active", metadata: { created_from: "homepaw_pilot" } });
  if (error) return databaseError("Groomer gagal dibuat", error.message);
  revalidatePath("/catalog"); revalidatePath("/bookings"); return { error: null, success: "Groomer berhasil ditambahkan." };
}

export async function adjustInventoryAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const branchId = idValue(formData, "branchId"); const productId = idValue(formData, "productId"); const quantity = numberValue(formData, "quantity"); const notes = textValue(formData, "notes", 200);
  if (!branchId || !productId || !quantity || quantity === 0) return databaseError("Inventaris", "produk, cabang, dan jumlah wajib diisi");
  const { error } = await context.supabase.from("inventory_movements").insert({ organization_id: context.organizationId, branch_id: branchId, product_id: productId, movement_type: "adjustment", quantity, notes: notes || "Penyesuaian dari Operro", metadata: { created_from: "homepaw_pilot" } });
  if (error) return databaseError("Penyesuaian gagal", error.message);
  revalidatePath("/inventory"); revalidatePath("/catalog"); return { error: null, success: "Stok berhasil disesuaikan." };
}

export async function recordPaymentAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const invoiceId = idValue(formData, "invoiceId"); const amount = numberValue(formData, "amount"); const method = textValue(formData, "method", 30);
  if (!invoiceId || !amount || amount <= 0 || !["cash", "card", "wallet", "bank_transfer", "other"].includes(method)) return databaseError("Pembayaran", "data tidak valid");
  const { data: invoice } = await context.supabase.from("invoices").select("id,branch_id,customer_id,total,status").eq("organization_id", context.organizationId).eq("id", invoiceId).eq("status", "issued").maybeSingle();
  if (!invoice) return databaseError("Pembayaran", "invoice tidak ditemukan atau sudah ditutup");
  const { error } = await context.supabase.from("payments").insert({ organization_id: context.organizationId, branch_id: invoice.branch_id, invoice_id: invoice.id, customer_id: invoice.customer_id, method, amount, currency: "IDR", status: "succeeded", external_ref: `MANUAL-${Date.now()}`, metadata: { created_from: "homepaw_pilot" } });
  if (error) return databaseError("Pembayaran gagal", error.message);
  const { data: rows } = await context.supabase.from("payments").select("amount").eq("organization_id", context.organizationId).eq("invoice_id", invoice.id).eq("status", "succeeded");
  const paid = (rows ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
  if (paid >= Number(invoice.total)) await context.supabase.from("invoices").update({ status: "paid", paid_at: new Date().toISOString() }).eq("organization_id", context.organizationId).eq("id", invoice.id);
  revalidatePath("/finance"); revalidatePath("/dashboard"); revalidatePath("/reports"); return { error: null, success: "Pembayaran berhasil dicatat." };
}

export async function recordExpenseAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const branchId = idValue(formData, "branchId"); const description = textValue(formData, "description", 160); const category = textValue(formData, "category", 80); const amount = numberValue(formData, "amount");
  if (!branchId || description.length < 3 || !amount || amount <= 0) return databaseError("Pengeluaran", "data tidak valid");
  const { error } = await context.supabase.from("expenses").insert({ organization_id: context.organizationId, branch_id: branchId, description, category: category || "Operasional", amount, currency: "IDR", status: "recorded", metadata: { created_from: "homepaw_pilot" } });
  if (error) return databaseError("Pengeluaran gagal", error.message);
  revalidatePath("/finance"); revalidatePath("/reports"); return { error: null, success: "Pengeluaran berhasil dicatat." };
}
