"use server";

/**
 * Function index:
 * - createCustomerAction: creates a customer and optional first pet and address.
 * - createCustomerAddressAction / updateCustomerAddressAction / deleteCustomerAddressAction / setDefaultCustomerAddressAction: manages saved addresses.
 * - createTaskAction / updateTaskStatusAction: manages operational tasks.
 * - transitionBookingAction / updatePetJobStatusAction: advances grooming work.
 * - setDispatchStageAction: advances a home-service booking's dispatch stage (scheduled/en_route/arrived/in_service), independent of bookings.status.
 * - uploadGroomingEvidenceAction: stores private, booking-linked grooming evidence for an assigned groomer.
 * - updateGroomingChecklistAction / issueInvoiceForBookingAction: closes the service-to-cash loop.
 * - createServiceAction / createResourceAction: configures the operating catalog.
 * - adjustInventoryAction: appends an inventory adjustment movement.
 * - recordPaymentAction / recordExpenseAction: records manual financial activity.
 * - sellPackageAction: sells a catalog package to a customer and records the payment.
 * - recomputePayrollRunAction / approvePayrollRunAction / markPayrollRunPaidAction: payroll lifecycle.
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
  return { supabase, organizationId: context.activeOrganization.id, userId: context.user.id };
}

function databaseError(scope: string, message: string) {
  return { error: `${scope}: ${message}`, success: null };
}

const PHONE_PATTERN = /^\+?[0-9][0-9 .\-()]{6,19}$/;
const POSTAL_PATTERN = /^[0-9]{4,10}$/;

interface AddressFieldValues {
  label: string;
  recipient_name: string | null;
  recipient_phone: string | null;
  line1: string;
  line2: string | null;
  rt: string | null;
  rw: string | null;
  kelurahan: string | null;
  kecamatan: string | null;
  kabupaten_kota: string | null;
  province: string | null;
  postal_code: string | null;
  landmark: string | null;
  access_notes: string | null;
  latitude: number | null;
  longitude: number | null;
}
interface AddressFieldsInvalid { invalid: string }

/** Reads the optional full-address fields shared by customer creation and address CRUD. */
function addressFields(formData: FormData): AddressFieldValues | AddressFieldsInvalid | null {
  const line1 = textValue(formData, "line1", 200);
  if (!line1) return null;
  const recipientPhone = textValue(formData, "recipientPhone", 40);
  const postalCode = textValue(formData, "postalCode", 10);
  if (recipientPhone && !PHONE_PATTERN.test(recipientPhone)) return { invalid: "Nomor telepon penerima tidak valid" };
  if (postalCode && !POSTAL_PATTERN.test(postalCode)) return { invalid: "Kode pos tidak valid" };
  // A local, stricter numeric reader: numberValue() treats a missing/empty field as 0
  // (Number("") === 0), which would silently place every address-less submission at
  // the Gulf of Guinea. Coordinates are optional, so blank must stay null, not 0.
  const coordinate = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const latitude = coordinate("latitude");
  const longitude = coordinate("longitude");
  return {
    label: textValue(formData, "label", 60) || "Rumah",
    recipient_name: textValue(formData, "recipientName", 120) || null,
    recipient_phone: recipientPhone || null,
    line1,
    line2: textValue(formData, "line2", 200) || null,
    rt: textValue(formData, "rt", 10) || null,
    rw: textValue(formData, "rw", 10) || null,
    kelurahan: textValue(formData, "kelurahan", 100) || null,
    kecamatan: textValue(formData, "kecamatan", 100) || null,
    kabupaten_kota: textValue(formData, "kabupatenKota", 100) || null,
    province: textValue(formData, "province", 100) || null,
    postal_code: postalCode || null,
    landmark: textValue(formData, "landmark", 200) || null,
    access_notes: textValue(formData, "accessNotes", 500) || null,
    latitude,
    longitude,
  };
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

  const address = addressFields(formData);
  if (address && "invalid" in address) return databaseError("Alamat", address.invalid);

  const { data: customer, error } = await context.supabase.from("customers").insert({ organization_id: context.organizationId, display_name: name, phone: phone || null, status: "active", source: "Operro", metadata: { created_from: "homepaw_pilot" } }).select("id").single();
  if (error || !customer) return databaseError("Pelanggan gagal dibuat", error?.message ?? "unknown");
  if (petName) {
    const { error: petError } = await context.supabase.from("pets").insert({ organization_id: context.organizationId, customer_id: customer.id, name: petName, species, breed: breed || null, status: "active", metadata: { created_from: "homepaw_pilot" } });
    if (petError) {
      await context.supabase.from("customers").update({ deleted_at: new Date().toISOString() }).eq("organization_id", context.organizationId).eq("id", customer.id);
      return databaseError("Hewan gagal dibuat", petError.message);
    }
  }
  if (address && !("invalid" in address)) {
    const { error: addressError } = await context.supabase.from("customer_addresses").insert({ organization_id: context.organizationId, customer_id: customer.id, is_default: true, ...address });
    // A bad address must not silently discard an otherwise-valid new customer — report it,
    // but the customer record (and pet, if any) already committed successfully above.
    if (addressError) return { error: null, success: `${name} berhasil ditambahkan, tetapi alamat gagal disimpan: ${addressError.message}` };
  }
  revalidatePath("/customers"); revalidatePath("/bookings"); revalidatePath("/dashboard");
  return { error: null, success: `${name} berhasil ditambahkan.` };
}

export async function createCustomerAddressAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace();
  if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const customerId = idValue(formData, "customerId");
  if (!customerId) return databaseError("Alamat", "pelanggan tidak valid");
  const address = addressFields(formData);
  if (!address) return databaseError("Alamat", "alamat baris pertama wajib diisi");
  if ("invalid" in address) return databaseError("Alamat", address.invalid);
  const { count } = await context.supabase.from("customer_addresses").select("id", { count: "exact", head: true }).eq("organization_id", context.organizationId).eq("customer_id", customerId).is("deleted_at", null);
  const { error } = await context.supabase.from("customer_addresses").insert({ organization_id: context.organizationId, customer_id: customerId, is_default: (count ?? 0) === 0, ...address });
  if (error) return databaseError("Alamat gagal disimpan", error.message);
  revalidatePath(`/customers/${customerId}`);
  return { error: null, success: "Alamat berhasil ditambahkan." };
}

export async function updateCustomerAddressAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace();
  if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const addressId = idValue(formData, "addressId");
  const customerId = idValue(formData, "customerId");
  if (!addressId || !customerId) return databaseError("Alamat", "alamat tidak valid");
  const address = addressFields(formData);
  if (!address) return databaseError("Alamat", "alamat baris pertama wajib diisi");
  if ("invalid" in address) return databaseError("Alamat", address.invalid);
  const { error } = await context.supabase.from("customer_addresses").update(address).eq("organization_id", context.organizationId).eq("customer_id", customerId).eq("id", addressId);
  if (error) return databaseError("Alamat gagal diperbarui", error.message);
  revalidatePath(`/customers/${customerId}`);
  return { error: null, success: "Alamat berhasil diperbarui." };
}

export async function deleteCustomerAddressAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const addressId = idValue(formData, "addressId");
  const customerId = idValue(formData, "customerId");
  if (!addressId || !customerId) return;
  await context.supabase.from("customer_addresses").update({ deleted_at: new Date().toISOString() }).eq("organization_id", context.organizationId).eq("customer_id", customerId).eq("id", addressId);
  revalidatePath(`/customers/${customerId}`);
}

export async function setDefaultCustomerAddressAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const addressId = idValue(formData, "addressId");
  const customerId = idValue(formData, "customerId");
  if (!addressId || !customerId) return;
  await context.supabase.schema("app").rpc("fn_set_default_customer_address", { p_address_id: addressId });
  revalidatePath(`/customers/${customerId}`);
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
  const app = context.supabase.schema("app");
  const result = status === "completed"
    ? await app.rpc("complete_booking", { p_booking: bookingId, p_override: false, p_reason: null })
    : await app.rpc("transition_booking_status", { p_booking: bookingId, p_to: status });
  if (result.error) throw new Error(`Status booking gagal diperbarui: ${result.error.message}`);
  revalidatePath("/operations"); revalidatePath("/bookings"); revalidatePath("/dashboard"); revalidatePath("/reports");
}

export async function updatePetJobStatusAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const petJobId = idValue(formData, "petJobId"); const status = textValue(formData, "status", 30);
  if (!petJobId || !allowedPetStatuses.has(status)) return;
  await context.supabase.from("grooming_job_pets").update({ status }).eq("organization_id", context.organizationId).eq("id", petJobId);
  revalidatePath("/operations"); revalidatePath("/my-schedule");
}

const allowedDispatchStages = new Set(["scheduled", "en_route", "arrived", "in_service"]);

/**
 * Advances a home-service booking's dispatch stage. This never touches `bookings.status` —
 * it calls `app.fn_set_dispatch_stage`, which is deliberately separate from and subordinate
 * to `app.transition_booking_status`/`app.complete_booking`. A dispatcher marking "arrived"
 * cannot accidentally (or otherwise) move a booking through the real, frozen state machine.
 */
export async function setDispatchStageAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const bookingId = idValue(formData, "bookingId");
  const stage = textValue(formData, "stage", 20);
  if (!bookingId || !allowedDispatchStages.has(stage)) return;
  await context.supabase.schema("app").rpc("fn_set_dispatch_stage", { p_booking: bookingId, p_stage: stage });
  revalidatePath("/operations"); revalidatePath("/my-schedule");
}

const allowedEvidenceCategories = new Set(["before", "after", "ear", "hygiene", "dematting", "fungal", "injury", "other", "attendance"]);
const evidenceMimeExtensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export async function uploadGroomingEvidenceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace();
  if (!context) return databaseError("Foto", "sesi atau workspace aktif tidak tersedia");
  const petJobId = idValue(formData, "petJobId");
  const bookingId = idValue(formData, "bookingId");
  const category = textValue(formData, "category", 30);
  const file = formData.get("photo");
  if (!petJobId || !bookingId || !allowedEvidenceCategories.has(category)) return databaseError("Foto", "data pekerjaan tidak valid");
  if (!(file instanceof File) || file.size === 0) return databaseError("Foto", "pilih foto terlebih dahulu");
  const extension = evidenceMimeExtensions[file.type];
  if (!extension) return databaseError("Foto", "format harus JPG, PNG, atau WebP");
  if (file.size > 4 * 1024 * 1024) return databaseError("Foto", "ukuran maksimum 4 MB setelah kompresi");

  const membership = await context.supabase.from("memberships").select("id").eq("organization_id", context.organizationId).eq("user_id", context.userId).eq("status", "active").is("deleted_at", null).maybeSingle();
  if (membership.error || !membership.data) return databaseError("Foto", "membership groomer tidak ditemukan");
  const resources = await context.supabase.from("resources").select("id").eq("organization_id", context.organizationId).eq("membership_id", membership.data.id).eq("status", "active").is("deleted_at", null);
  if (resources.error) return databaseError("Foto", resources.error.message);
  const resourceIds = (resources.data ?? []).map((resource) => resource.id);
  if (resourceIds.length === 0) return databaseError("Foto", "akun ini belum terhubung ke profil groomer");
  const assignment = await context.supabase.from("grooming_job_pets").select("id,grooming_job_id").eq("organization_id", context.organizationId).eq("id", petJobId).eq("grooming_job_id", bookingId).in("assigned_resource_id", resourceIds).is("deleted_at", null).maybeSingle();
  if (assignment.error || !assignment.data) return databaseError("Foto", "pekerjaan ini tidak ditugaskan ke akun Anda");

  const storagePath = `${context.organizationId}/${bookingId}/${petJobId}/${crypto.randomUUID()}.${extension}`;
  const upload = await context.supabase.storage.from("attachments").upload(storagePath, file, { contentType: file.type, upsert: false });
  if (upload.error) return databaseError("Foto gagal diunggah", upload.error.message);

  const attachment = await context.supabase.from("attachments").insert({
    organization_id: context.organizationId,
    storage_bucket: "attachments",
    storage_path: storagePath,
    filename: file.name.slice(0, 200) || `${category}.${extension}`,
    mime_type: file.type,
    size_bytes: file.size,
    uploaded_by: context.userId,
    metadata: { category, grooming_job_pet_id: petJobId },
  }).select("id").single();
  if (attachment.error || !attachment.data) {
    await context.supabase.storage.from("attachments").remove([storagePath]);
    return databaseError("Metadata foto gagal disimpan", attachment.error?.message ?? "unknown");
  }
  const link = await context.supabase.from("attachment_links").insert({ organization_id: context.organizationId, attachment_id: attachment.data.id, subject_type: "booking", subject_id: bookingId });
  if (link.error) {
    await context.supabase.from("attachments").delete().eq("organization_id", context.organizationId).eq("id", attachment.data.id);
    await context.supabase.storage.from("attachments").remove([storagePath]);
    return databaseError("Foto gagal ditautkan", link.error.message);
  }
  revalidatePath("/my-schedule"); revalidatePath("/operations");
  return { error: null, success: "Foto berhasil disimpan." };
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

/**
 * Sells a catalog package to a customer: creates the customer_packages entry and records
 * the payment directly (payments.invoice_id is nullable — an invoice is not required).
 * Packages have no service/product catalog row, so they cannot become an order_item
 * (item_type only allows service|product) and cannot flow through invoices the way a
 * booking does — this is a genuine schema gap, not an oversight.
 */
export async function sellPackageAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const customerId = idValue(formData, "customerId"); const packageId = idValue(formData, "packageId"); const branchId = idValue(formData, "branchId");
  const method = textValue(formData, "method", 30);
  if (!customerId || !packageId || !branchId || !["cash", "card", "wallet", "bank_transfer", "other"].includes(method)) return databaseError("Paket", "data tidak valid");
  const { data: pkg } = await context.supabase.from("packages").select("id,name,total_sessions,price,currency,validity_days").eq("organization_id", context.organizationId).eq("id", packageId).eq("is_active", true).maybeSingle();
  if (!pkg) return databaseError("Paket", "paket tidak ditemukan");
  const purchasedAt = new Date();
  const expiresAt = pkg.validity_days != null ? new Date(purchasedAt.getTime() + pkg.validity_days * 86_400_000).toISOString() : null;
  const { error: purchaseError } = await context.supabase.from("customer_packages").insert({ organization_id: context.organizationId, customer_id: customerId, package_id: pkg.id, sessions_remaining: pkg.total_sessions, purchased_at: purchasedAt.toISOString(), expires_at: expiresAt, status: "active", metadata: { created_from: "homepaw_pilot" } });
  if (purchaseError) return databaseError("Paket gagal dijual", purchaseError.message);
  if (Number(pkg.price) > 0) {
    const { error: paymentError } = await context.supabase.from("payments").insert({ organization_id: context.organizationId, branch_id: branchId, customer_id: customerId, method, amount: pkg.price, currency: pkg.currency, status: "succeeded", external_ref: `PACKAGE-${Date.now()}`, metadata: { created_from: "homepaw_pilot", kind: "package_purchase", package_id: pkg.id } });
    if (paymentError) return databaseError("Paket tersimpan, tapi pembayaran gagal dicatat", paymentError.message);
  }
  revalidatePath("/programs"); revalidatePath(`/customers/${customerId}`); revalidatePath("/finance");
  return { error: null, success: `${pkg.name} berhasil dijual.` };
}

/**
 * Payroll lifecycle. payroll_items are insert-only once written (DB trigger blocks direct
 * update), so "recompute" deletes and reinserts while the run is still draft. Base pay
 * comes from staff_compensation as-is — there is no hours-worked/attendance table in this
 * schema, so hourly pay_type cannot be computed from real hours; this is a genuine gap,
 * not a bug.
 */
export async function recomputePayrollRunAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const periodStart = textValue(formData, "periodStart", 10); const periodEnd = textValue(formData, "periodEnd", 10);
  if (!periodStart || !periodEnd) return;

  const { data: existingRun } = await context.supabase.from("payroll_runs").select("id,status").eq("organization_id", context.organizationId).eq("period_start", periodStart).eq("period_end", periodEnd).maybeSingle();
  if (existingRun && existingRun.status !== "draft") return;

  let runId = existingRun?.id ?? null;
  if (!runId) {
    const { data: run, error: runError } = await context.supabase.from("payroll_runs").insert({ organization_id: context.organizationId, period_start: periodStart, period_end: periodEnd, status: "draft" }).select("id").single();
    if (runError || !run) return;
    runId = run.id;
  } else {
    await context.supabase.from("payroll_items").delete().eq("organization_id", context.organizationId).eq("payroll_run_id", runId);
  }

  const [staffResult, commissionResult] = await Promise.all([
    context.supabase.from("staff_compensation").select("membership_id,base_amount").eq("organization_id", context.organizationId).eq("is_active", true).is("deleted_at", null),
    context.supabase.from("commission_entries").select("membership_id,commission_amount").eq("organization_id", context.organizationId).eq("status", "accrued").gte("occurred_at", periodStart).lt("occurred_at", periodEnd),
  ]);
  const commissionByMembership = new Map<string, number>();
  for (const row of commissionResult.data ?? []) commissionByMembership.set(row.membership_id, (commissionByMembership.get(row.membership_id) ?? 0) + Number(row.commission_amount));

  const staff = staffResult.data ?? [];
  if (staff.length > 0) {
    await context.supabase.from("payroll_items").insert(staff.map((s) => {
      const basePay = Number(s.base_amount); const commissionTotal = commissionByMembership.get(s.membership_id) ?? 0; const grossPay = Math.round((basePay + commissionTotal) * 100) / 100;
      return { organization_id: context.organizationId, payroll_run_id: runId, membership_id: s.membership_id, base_pay: basePay, commission_total: commissionTotal, gross_pay: grossPay, net_pay: grossPay, breakdown: { base_pay: basePay, commission_total: commissionTotal } };
    }));
  }
  revalidatePath("/payroll");
}

export async function approvePayrollRunAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const runId = idValue(formData, "runId"); if (!runId) return;
  const { data: items } = await context.supabase.from("payroll_items").select("gross_pay,net_pay").eq("organization_id", context.organizationId).eq("payroll_run_id", runId);
  const totalGross = (items ?? []).reduce((sum, i) => sum + Number(i.gross_pay), 0);
  const totalNet = (items ?? []).reduce((sum, i) => sum + Number(i.net_pay), 0);
  await context.supabase.from("payroll_runs").update({ status: "approved", approved_at: new Date().toISOString(), total_gross: totalGross, total_net: totalNet }).eq("organization_id", context.organizationId).eq("id", runId).eq("status", "draft");
  revalidatePath("/payroll");
}

export async function markPayrollRunPaidAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  const runId = idValue(formData, "runId"); if (!runId) return;
  await context.supabase.from("payroll_runs").update({ status: "paid", paid_at: new Date().toISOString() }).eq("organization_id", context.organizationId).eq("id", runId).eq("status", "approved");
  revalidatePath("/payroll");
}
