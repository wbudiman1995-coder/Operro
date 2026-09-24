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
 * - createServiceAction / createResourceAction / updateResourceAction / archiveResourceAction: configures the operating catalog.
 * - adjustInventoryAction: appends an inventory adjustment movement.
 * - recordPaymentAction / recordExpenseAction: records manual financial activity.
 * - sellPackageAction: sells a catalog package to a customer and records the payment.
 * - setCustomerNextDiscountAction / revokeCustomerNextDiscountAction: manages a customer's one-use next-booking offer.
 * - recomputePayrollRunAction / approvePayrollRunAction / markPayrollRunPaidAction: payroll lifecycle.
 */
import "server-only";

import { revalidatePath } from "next/cache";

import { loadAuthContext } from "@/lib/auth-context";
import { loadCapabilities } from "@/lib/authorization";
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

export async function setCustomerNextDiscountAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const customerId = idValue(formData, "customerId");
  if (!customerId) return databaseError("Diskon", "pelanggan tidak valid");
  const rules: Record<string, { type: string; value: number }> = {};
  for (const [scope, prefix] of [["basic_grooming", "basic"], ["styling", "styling"], ["other", "other"]] as const) {
    const type = textValue(formData, `${prefix}Type`, 10);
    const value = numberValue(formData, `${prefix}Value`);
    if (value !== null && value > 0) rules[scope] = { type: type === "fixed" ? "fixed" : "percent", value };
  }
  if (Object.keys(rules).length === 0) return databaseError("Diskon", "isi minimal satu aturan diskon");
  const expiresDate = textValue(formData, "expiresAt", 10);
  const expiresAt = expiresDate ? new Date(`${expiresDate}T23:59:59+07:00`).toISOString() : null;
  const result = await context.supabase.schema("app").rpc("set_customer_next_discount", {
    p_customer: customerId,
    p_rules: rules,
    p_expires_at: expiresAt,
    p_note: textValue(formData, "note", 500) || null,
    p_label: textValue(formData, "label", 120) || "Complimentary next appointment",
  });
  if (result.error) return databaseError("Diskon gagal disimpan", result.error.message);
  revalidatePath("/customers"); revalidatePath(`/customers/${customerId}`); revalidatePath("/bookings");
  return { error: null, success: "Diskon satu kali siap dipakai otomatis pada booking berikutnya." };
}

export async function revokeCustomerNextDiscountAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const customerId = idValue(formData, "customerId"); const offerId = idValue(formData, "offerId");
  if (!customerId || !offerId) return databaseError("Diskon", "penawaran tidak valid");
  const result = await context.supabase.schema("app").rpc("revoke_customer_next_discount", { p_offer: offerId });
  if (result.error) return databaseError("Diskon gagal dicabut", result.error.message);
  revalidatePath("/customers"); revalidatePath(`/customers/${customerId}`); revalidatePath("/bookings");
  return { error: null, success: "Diskon booking berikutnya dicabut." };
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

export async function importCustomerHouseholdAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace();
  if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const capabilities = await loadCapabilities(context.supabase);
  if (!capabilities["customer.manage"]) return databaseError("Impor", "Anda tidak memiliki izin mengelola pelanggan");
  const raw = textValue(formData, "household", 20_000);
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { return databaseError("Impor", "hasil parsing tidak valid"); }
  const name = typeof payload.customerName === "string" ? payload.customerName.trim().slice(0, 120) : "";
  const phone = typeof payload.phone === "string" ? payload.phone.trim().slice(0, 40) : "";
  const source = typeof payload.source === "string" ? payload.source.trim().slice(0, 80) : "Fast booking import";
  const pets = Array.isArray(payload.pets) ? payload.pets.slice(0, 10) : [];
  if (name.length < 2 || pets.length === 0) return databaseError("Impor", "nama pelanggan dan minimal satu hewan wajib ada");
  if (phone && !PHONE_PATTERN.test(phone)) return databaseError("Impor", "nomor WhatsApp tidak valid");
  const petRows = pets.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const pet = value as Record<string, unknown>;
    const petName = typeof pet.name === "string" ? pet.name.trim().slice(0, 80) : "";
    if (!petName) return [];
    const weight = pet.weightKg === null || pet.weightKg === "" ? null : Number(pet.weightKg);
    return [{ name: petName, species: pet.species === "cat" ? "cat" : "dog", breed: typeof pet.breed === "string" ? pet.breed.trim().slice(0, 100) || null : null, weight_kg: Number.isFinite(weight) && Number(weight) > 0 ? Number(weight) : null, color: typeof pet.color === "string" ? pet.color.trim().slice(0, 80) || null : null, notes: typeof pet.notes === "string" ? pet.notes.trim().slice(0, 1000) || null : null, metadata: { created_from: "booking_chat_import", stated_age: typeof pet.age === "string" ? pet.age.trim().slice(0, 80) : "" } }];
  });
  if (petRows.length !== pets.length) return databaseError("Impor", "setiap hewan harus memiliki nama");

  if (phone) {
    const localPhone = phone.startsWith("+62") ? `0${phone.slice(3)}` : phone;
    const duplicate = await context.supabase.from("customers").select("id").eq("organization_id", context.organizationId).is("deleted_at", null).in("phone", [...new Set([phone, localPhone])]).limit(1);
    if (duplicate.error) return databaseError("Impor", "pemeriksaan duplikat gagal");
    if ((duplicate.data ?? []).length > 0) return databaseError("Impor", "nomor WhatsApp sudah digunakan pelanggan lain. Buka pelanggan yang ada agar tidak membuat duplikat");
  }

  const { data: customer, error: customerError } = await context.supabase.from("customers").insert({ organization_id: context.organizationId, display_name: name, phone: phone || null, status: "active", source: source || "Fast booking import", metadata: { created_from: "booking_chat_import", original_maps_input: typeof payload.mapsInput === "string" ? payload.mapsInput.slice(0, 1000) : null } }).select("id").single();
  if (customerError || !customer) return databaseError("Impor pelanggan gagal", customerError?.message ?? "unknown");
  const { error: petsError } = await context.supabase.from("pets").insert(petRows.map((pet) => ({ ...pet, organization_id: context.organizationId, customer_id: customer.id, status: "active" })));
  if (petsError) {
    await context.supabase.from("customers").update({ deleted_at: new Date().toISOString() }).eq("organization_id", context.organizationId).eq("id", customer.id);
    return databaseError("Impor hewan gagal", petsError.message);
  }
  const line1 = typeof payload.addressLine === "string" ? payload.addressLine.trim().slice(0, 200) : "";
  if (line1) {
    const latitude = payload.latitude === null ? null : Number(payload.latitude);
    const longitude = payload.longitude === null ? null : Number(payload.longitude);
    const validCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(Number(latitude)) <= 90 && Math.abs(Number(longitude)) <= 180;
    const { error: addressError } = await context.supabase.from("customer_addresses").insert({ organization_id: context.organizationId, customer_id: customer.id, label: "Rumah", recipient_name: name, recipient_phone: phone || null, line1, kecamatan: typeof payload.kecamatan === "string" ? payload.kecamatan.trim().slice(0, 100) || null : null, kabupaten_kota: typeof payload.kabupatenKota === "string" ? payload.kabupatenKota.trim().slice(0, 100) || null : null, latitude: validCoordinates ? latitude : null, longitude: validCoordinates ? longitude : null, is_default: true });
    if (addressError) return { error: null, success: `${name} dan ${petRows.length} hewan dibuat, tetapi alamat perlu diperiksa: ${addressError.message}` };
  }
  revalidatePath("/customers"); revalidatePath("/bookings"); revalidatePath("/dashboard");
  return { error: null, success: `${name} dan ${petRows.length} hewan berhasil diimpor.` };
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

export async function recordAttendanceCheckinAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace();
  if (!context) return databaseError("Kehadiran", "sesi atau workspace aktif tidak tersedia");
  const bookingId = idValue(formData, "bookingId"); const resourceId = idValue(formData, "resourceId");
  const latitudeRaw = String(formData.get("latitude") ?? "").trim(); const longitudeRaw = String(formData.get("longitude") ?? "").trim(); const accuracyRaw = String(formData.get("accuracy") ?? "").trim();
  const latitude = Number(latitudeRaw); const longitude = Number(longitudeRaw); const accuracy = accuracyRaw ? Number(accuracyRaw) : Number.NaN;
  const lateReason = textValue(formData, "lateReason", 500); const file = formData.get("photo");
  if (!bookingId || !resourceId || !latitudeRaw || !longitudeRaw || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return databaseError("Kehadiran", "GPS wajib diaktifkan sebelum check-in");
  if (!(file instanceof File) || file.size === 0) return databaseError("Kehadiran", "foto check-in wajib diambil");
  const extension = evidenceMimeExtensions[file.type];
  if (!extension || file.size > 4 * 1024 * 1024) return databaseError("Kehadiran", "foto harus JPG, PNG, atau WebP maksimum 4 MB");
  const membership = await context.supabase.from("memberships").select("id").eq("organization_id", context.organizationId).eq("user_id", context.userId).eq("status", "active").is("deleted_at", null).maybeSingle();
  if (!membership.data) return databaseError("Kehadiran", "membership aktif tidak ditemukan");
  const resource = await context.supabase.from("resources").select("id").eq("organization_id", context.organizationId).eq("id", resourceId).eq("membership_id", membership.data.id).eq("status", "active").is("deleted_at", null).maybeSingle();
  if (!resource.data) return databaseError("Kehadiran", "profil groomer tidak terhubung ke akun ini");
  const assigned = await context.supabase.from("grooming_job_pets").select("id").eq("organization_id", context.organizationId).eq("grooming_job_id", bookingId).eq("assigned_resource_id", resourceId).is("deleted_at", null).limit(1);
  if (!(assigned.data ?? []).length) return databaseError("Kehadiran", "booking tidak ditugaskan kepada groomer ini");

  const storagePath = `${context.organizationId}/${bookingId}/attendance/${crypto.randomUUID()}.${extension}`;
  const upload = await context.supabase.storage.from("attachments").upload(storagePath, file, { contentType: file.type, upsert: false });
  if (upload.error) return databaseError("Foto check-in gagal diunggah", upload.error.message);
  const attachment = await context.supabase.from("attachments").insert({ organization_id: context.organizationId, storage_bucket: "attachments", storage_path: storagePath, filename: file.name.slice(0, 200) || `attendance.${extension}`, mime_type: file.type, size_bytes: file.size, uploaded_by: context.userId, metadata: { category: "attendance", resource_id: resourceId, latitude, longitude, accuracy_meters: Number.isFinite(accuracy) ? accuracy : null } }).select("id").single();
  if (!attachment.data) { await context.supabase.storage.from("attachments").remove([storagePath]); return databaseError("Metadata check-in gagal", attachment.error?.message ?? "unknown"); }
  const link = await context.supabase.from("attachment_links").insert({ organization_id: context.organizationId, attachment_id: attachment.data.id, subject_type: "booking", subject_id: bookingId });
  if (link.error) { await context.supabase.storage.from("attachments").remove([storagePath]); return databaseError("Foto check-in gagal ditautkan", link.error.message); }
  const result = await context.supabase.schema("app").rpc("record_attendance_checkin", { p_booking: bookingId, p_resource: resourceId, p_attachment: attachment.data.id, p_latitude: latitude, p_longitude: longitude, p_accuracy: Number.isFinite(accuracy) ? accuracy : null, p_late_reason: lateReason || null });
  if (result.error) {
    await context.supabase.storage.from("attachments").remove([storagePath]);
    if (/already_recorded|23505/i.test(result.error.message)) return databaseError("Kehadiran", "check-in untuk booking ini sudah tercatat");
    if (/photo_required|location_required|not_assigned|not_owned|membership_not_found/i.test(result.error.message)) return databaseError("Check-in gagal", "data foto, GPS, atau penugasan tidak valid");
    console.error("attendance check-in RPC failed", { code: result.error.code, message: result.error.message });
    return databaseError("Check-in gagal", "server tidak dapat mencatat kehadiran. Coba lagi.");
  }
  revalidatePath("/my-schedule"); revalidatePath("/attendance"); revalidatePath("/payroll"); revalidatePath("/catalog");
  return { error: null, success: "Check-in GPS dan foto berhasil dicatat." };
}

export async function waiveAttendanceLatenessAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Kehadiran", "workspace aktif tidak tersedia");
  const attendanceId = idValue(formData, "attendanceId"); const reason = textValue(formData, "reason", 500);
  if (!attendanceId || reason.length < 3) return databaseError("Kehadiran", "alasan waiver wajib diisi");
  const result = await context.supabase.schema("app").rpc("waive_attendance_lateness", { p_attendance: attendanceId, p_reason: reason });
  if (result.error) return databaseError("Waiver gagal", /not_authorized|42501/i.test(result.error.message) ? "izin payroll.manage diperlukan" : result.error.message);
  revalidatePath("/attendance"); revalidatePath("/payroll"); revalidatePath("/catalog");
  return { error: null, success: "Keterlambatan di-waive dan audit tersimpan." };
}

export async function syncMissingAttendanceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Kehadiran", "workspace aktif tidak tersedia");
  const from = textValue(formData, "from", 10); const to = textValue(formData, "to", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return databaseError("Kehadiran", "rentang cycle tidak valid");
  const result = await context.supabase.schema("app").rpc("materialize_missing_attendance", { p_from: `${from}T00:00:00+07:00`, p_to: `${to}T00:00:00+07:00` });
  if (result.error) return databaseError("Sinkronisasi gagal", /not_authorized|42501/i.test(result.error.message) ? "izin payroll.manage diperlukan" : result.error.message);
  revalidatePath("/attendance"); revalidatePath("/payroll"); revalidatePath("/catalog");
  return { error: null, success: `${Number(result.data ?? 0)} ketidakhadiran tanpa foto ditambahkan.` };
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
  const { data: booking } = await context.supabase.from("bookings").select("id,branch_id,customer_id,status,metadata").eq("organization_id", context.organizationId).eq("id", bookingId).eq("status", "completed").maybeSingle();
  if (!booking) return;
  const { data: existingOrders } = await context.supabase.from("orders").select("id").eq("organization_id", context.organizationId).eq("booking_id", bookingId).is("deleted_at", null);
  if ((existingOrders ?? []).length) {
    const { data: existingInvoice } = await context.supabase.from("invoices").select("id").eq("organization_id", context.organizationId).in("order_id", existingOrders!.map((row) => row.id)).limit(1).maybeSingle();
    if (existingInvoice) return;
  }
  const { data: jobPets } = await context.supabase.from("grooming_job_pets").select("id").eq("organization_id", context.organizationId).eq("grooming_job_id", bookingId).is("deleted_at", null);
  const jobPetIds = (jobPets ?? []).map((row) => row.id); if (!jobPetIds.length) return;
  const { data: lines } = await context.supabase.from("grooming_job_pet_services").select("id,service_id,service_name_snapshot,quantity,unit_price_snapshot,currency").eq("organization_id", context.organizationId).in("grooming_job_pet_id", jobPetIds).is("deleted_at", null).order("id");
  if (!lines?.length) return;
  const { data: packageReservations, error: packageCoverageError } = await context.supabase.schema("app").rpc("list_booking_package_coverage", { p_booking: bookingId });
  if (packageCoverageError) {
    console.error("booking_package_coverage_failed", packageCoverageError);
    return;
  }
  const packageByLine = new Map((packageReservations ?? []).map((item: { line_id: string; customer_package_id: string }) => [item.line_id, item.customer_package_id]));
  const bookingMetadata = booking.metadata && typeof booking.metadata === "object" && !Array.isArray(booking.metadata) ? booking.metadata as Record<string, unknown> : {};
  const offer = bookingMetadata.complimentary_next_discount && typeof bookingMetadata.complimentary_next_discount === "object" && !Array.isArray(bookingMetadata.complimentary_next_discount) ? bookingMetadata.complimentary_next_discount as Record<string, unknown> : {};
  const lineDiscounts = offer.lineDiscounts && typeof offer.lineDiscounts === "object" && !Array.isArray(offer.lineDiscounts) ? offer.lineDiscounts as Record<string, unknown> : {};
  const categorySnapshot = bookingMetadata.category_discounts && typeof bookingMetadata.category_discounts === "object" && !Array.isArray(bookingMetadata.category_discounts) ? bookingMetadata.category_discounts as Record<string, unknown> : {};
  const categoryRules = Array.isArray(categorySnapshot.rules) ? categorySnapshot.rules.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  const serviceCategories = categorySnapshot.service_categories && typeof categorySnapshot.service_categories === "object" && !Array.isArray(categorySnapshot.service_categories) ? categorySnapshot.service_categories as Record<string, unknown> : {};
  const fixedRemaining = new Map(categoryRules.filter((rule) => rule.type === "fixed" && typeof rule.category === "string").map((rule) => [String(rule.category), Number(rule.value) || 0]));
  const pricedLines = lines.map((line) => {
    const gross = Number(line.unit_price_snapshot) * Number(line.quantity);
    const detail = lineDiscounts[line.id] && typeof lineDiscounts[line.id] === "object" && !Array.isArray(lineDiscounts[line.id]) ? lineDiscounts[line.id] as Record<string, unknown> : {};
    const complimentaryDiscount = Math.max(0, Number(detail.amount) || 0);
    const category = typeof serviceCategories[line.service_id] === "string" ? String(serviceCategories[line.service_id]) : "Lainnya";
    const rule = categoryRules.find((item) => item.category === category);
    let categoryDiscount = 0;
    if (rule?.type === "percent") categoryDiscount = gross * Math.min(100, Math.max(0, Number(rule.value) || 0)) / 100;
    if (rule?.type === "fixed") { categoryDiscount = Math.min(gross, fixedRemaining.get(category) ?? 0); fixedRemaining.set(category, Math.max(0, (fixedRemaining.get(category) ?? 0) - categoryDiscount)); }
    const packageId = packageByLine.get(line.id) ?? null;
    const discount = packageId ? gross : Math.max(0, Math.min(gross, complimentaryDiscount + categoryDiscount));
    return { ...line, gross, discount, discountDetail: detail, category, categoryDiscount, packageId };
  });
  const { data: order, error: orderError } = await context.supabase.from("orders").insert({ organization_id: context.organizationId, branch_id: booking.branch_id, customer_id: booking.customer_id, booking_id: booking.id, status: "confirmed", currency: "IDR", metadata: { created_from: "homepaw_pilot" } }).select("id").single();
  if (orderError || !order) return;
  const { error: itemError } = await context.supabase.from("order_items").insert(pricedLines.map((line) => ({ organization_id: context.organizationId, order_id: order.id, item_type: "service", service_id: line.service_id, name_snapshot: line.service_name_snapshot, quantity: line.quantity, unit_price: line.unit_price_snapshot, discount_amount: line.discount, line_total: line.gross - line.discount, pricing_breakdown: { source: "grooming_job_line", ...(Number(line.discountDetail.amount) > 0 ? { complimentary_next_discount: line.discountDetail } : {}), ...(line.categoryDiscount > 0 ? { category_discount: { category: line.category, amount: line.categoryDiscount } } : {}), ...(line.packageId ? { package_coverage: { customer_package_id: line.packageId } } : {}) }, metadata: { created_from: "homepaw_pilot", grooming_job_pet_service_id: line.id } })));
  if (itemError) { await context.supabase.from("orders").update({ status: "canceled" }).eq("id", order.id); return; }
  const { data: pricedOrder } = await context.supabase.from("orders").select("subtotal,discount_total,tax_total,total,currency").eq("organization_id", context.organizationId).eq("id", order.id).single();
  if (!pricedOrder) return;
  const invoiceNumber = `INV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${Date.now().toString().slice(-6)}`;
  const { data: invoice, error: invoiceError } = await context.supabase.from("invoices").insert({ organization_id: context.organizationId, branch_id: booking.branch_id, customer_id: booking.customer_id, order_id: order.id, invoice_number: invoiceNumber, status: "issued", currency: pricedOrder.currency, subtotal: pricedOrder.subtotal, discount_total: pricedOrder.discount_total, tax_total: pricedOrder.tax_total, total: pricedOrder.total, due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), metadata: { created_from: "homepaw_pilot", booking_id: booking.id } }).select("id").single();
  if (invoiceError || !invoice) return;
  await context.supabase.from("invoice_lines").insert(pricedLines.map((line) => ({ organization_id: context.organizationId, invoice_id: invoice.id, item_type: "service", name_snapshot: line.service_name_snapshot, quantity: line.quantity, unit_price: line.unit_price_snapshot, discount_amount: line.discount, line_total: line.gross - line.discount, pricing_breakdown: { source: "grooming_job_line", ...(Number(line.discountDetail.amount) > 0 ? { complimentary_next_discount: line.discountDetail } : {}), ...(line.categoryDiscount > 0 ? { category_discount: { category: line.category, amount: line.categoryDiscount } } : {}), ...(line.packageId ? { package_coverage: { customer_package_id: line.packageId } } : {}) } })));
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

function resourceSettings(formData: FormData) {
  const latitudeText = textValue(formData, "latitude", 30);
  const longitudeText = textValue(formData, "longitude", 30);
  const latitude = latitudeText ? Number(latitudeText) : null;
  const longitude = longitudeText ? Number(longitudeText) : null;
  const color = textValue(formData, "color", 7);
  return {
    phone: textValue(formData, "phone", 30) || null,
    calendar_color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#0f766e",
    base_location: {
      label: textValue(formData, "baseLabel", 160) || null,
      latitude: latitude !== null && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 ? latitude : null,
      longitude: longitude !== null && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 ? longitude : null,
    },
  };
}

async function validateResourceBranchAndMembership(context: NonNullable<Awaited<ReturnType<typeof workspace>>>, branchId: string, membershipId: string | null) {
  const [branch, membership] = await Promise.all([
    context.supabase.from("branches").select("id").eq("organization_id", context.organizationId).eq("id", branchId).eq("status", "active").is("deleted_at", null).maybeSingle(),
    membershipId ? context.supabase.from("memberships").select("id").eq("organization_id", context.organizationId).eq("id", membershipId).eq("status", "active").is("deleted_at", null).maybeSingle() : Promise.resolve({ data: { id: null }, error: null }),
  ]);
  return Boolean(branch.data && membership.data);
}

export async function createResourceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["resource.manage"]) return databaseError("Groomer", "izin resource.manage diperlukan");
  const branchId = idValue(formData, "branchId"); const membershipId = idValue(formData, "membershipId"); const name = textValue(formData, "name", 100);
  if (!branchId || name.length < 2) return databaseError("Groomer", "nama dan cabang wajib diisi");
  if (!(await validateResourceBranchAndMembership(context, branchId, membershipId))) return databaseError("Groomer", "cabang atau akun staf tidak dapat diakses");
  const { error } = await context.supabase.from("resources").insert({ organization_id: context.organizationId, branch_id: branchId, membership_id: membershipId, kind: "staff", name, capacity: 1, skills: ["grooming"], status: "active", settings: resourceSettings(formData), metadata: { created_from: "homepaw_pilot" } });
  if (error) return databaseError("Groomer gagal dibuat", error.message);
  revalidatePath("/catalog"); revalidatePath("/bookings"); revalidatePath("/schedule"); return { error: null, success: "Groomer berhasil ditambahkan." };
}

export async function updateResourceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["resource.manage"]) return databaseError("Groomer", "izin resource.manage diperlukan");
  const resourceId = idValue(formData, "resourceId"); const branchId = idValue(formData, "branchId"); const membershipId = idValue(formData, "membershipId");
  const name = textValue(formData, "name", 100); const status = textValue(formData, "status", 20);
  if (!resourceId || !branchId || name.length < 2 || !["active", "maintenance", "retired"].includes(status)) return databaseError("Groomer", "data perubahan tidak valid");
  if (!(await validateResourceBranchAndMembership(context, branchId, membershipId))) return databaseError("Groomer", "cabang atau akun staf tidak dapat diakses");
  const current = await context.supabase.from("resources").select("settings").eq("organization_id", context.organizationId).eq("id", resourceId).eq("kind", "staff").is("deleted_at", null).maybeSingle();
  if (!current.data) return databaseError("Groomer", "profil tidak ditemukan");
  const existingSettings = current.data.settings && typeof current.data.settings === "object" && !Array.isArray(current.data.settings) ? current.data.settings as Record<string, unknown> : {};
  const { error } = await context.supabase.from("resources").update({ branch_id: branchId, membership_id: membershipId, name, status, settings: { ...existingSettings, ...resourceSettings(formData) } }).eq("organization_id", context.organizationId).eq("id", resourceId).eq("kind", "staff").is("deleted_at", null);
  if (error) return databaseError("Groomer gagal diperbarui", error.message);
  revalidatePath("/catalog"); revalidatePath("/bookings"); revalidatePath("/schedule"); return { error: null, success: "Profil groomer diperbarui." };
}

export async function archiveResourceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["resource.manage"]) return databaseError("Groomer", "izin resource.manage diperlukan");
  const resourceId = idValue(formData, "resourceId");
  if (!resourceId || textValue(formData, "confirm", 10) !== "yes") return databaseError("Groomer", "konfirmasi arsip tidak valid");
  const now = new Date().toISOString();
  const { data: future } = await context.supabase.from("booking_resources").select("booking_id,bookings!inner(starts_at,status,deleted_at)").eq("organization_id", context.organizationId).eq("resource_id", resourceId).eq("is_active", true).gt("bookings.starts_at", now).is("bookings.deleted_at", null).not("bookings.status", "in", "(canceled,no_show,completed)").limit(1);
  if (future?.length) return databaseError("Groomer", "masih memiliki booking aktif mendatang; pindahkan booking sebelum mengarsipkan");
  const { error } = await context.supabase.from("resources").update({ status: "retired", deleted_at: now }).eq("organization_id", context.organizationId).eq("id", resourceId).eq("kind", "staff").is("deleted_at", null);
  if (error) return databaseError("Groomer gagal diarsipkan", error.message);
  revalidatePath("/catalog"); revalidatePath("/bookings"); revalidatePath("/schedule"); return { error: null, success: "Groomer diarsipkan dengan aman." };
}

export async function updateResourceCompensationAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const resourceId = idValue(formData, "resourceId"); const membershipId = idValue(formData, "membershipId");
  const payType = textValue(formData, "payType", 20); const baseAmount = numberValue(formData, "baseAmount");
  if (!resourceId || !membershipId || !["salary", "hourly"].includes(payType) || baseAmount === null || baseAmount < 0) return databaseError("Kompensasi", "data gaji tidak valid");
  const capabilities = await loadCapabilities(context.supabase);
  if (!capabilities["payroll.manage"]) return databaseError("Kompensasi", "izin payroll.manage diperlukan");
  const { data: resource } = await context.supabase.from("resources").select("id").eq("organization_id", context.organizationId).eq("id", resourceId).eq("membership_id", membershipId).eq("kind", "staff").is("deleted_at", null).maybeSingle();
  if (!resource) return databaseError("Kompensasi", "groomer belum terhubung ke akun staf aktif");
  const current = await context.supabase.from("staff_compensation").select("id").eq("organization_id", context.organizationId).eq("membership_id", membershipId).eq("is_active", true).is("deleted_at", null).order("effective_from", { ascending: false }).limit(1).maybeSingle();
  const write = current.data
    ? await context.supabase.from("staff_compensation").update({ pay_type: payType, base_amount: baseAmount, currency: "IDR" }).eq("organization_id", context.organizationId).eq("id", current.data.id)
    : await context.supabase.from("staff_compensation").insert({ organization_id: context.organizationId, membership_id: membershipId, pay_type: payType, base_amount: baseAmount, currency: "IDR", is_active: true, metadata: { created_from: "groomer_management" } });
  if (write.error) return databaseError("Kompensasi gagal disimpan", write.error.message);
  revalidatePath("/catalog"); revalidatePath("/payroll"); return { error: null, success: "Kompensasi groomer disimpan." };
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
 * comes from staff_compensation as-is. Attendance exceptions are reviewed separately;
 * #32 will add explicit hours and adjustment rules before they affect net pay.
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
