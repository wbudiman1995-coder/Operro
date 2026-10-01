"use server";

import { correctedMembershipExpiry } from "@/lib/membership-correction";
import { pricingBand } from "@/lib/pet-sizing";

/**
 * Function index:
 * - createCustomerAction: atomically creates a customer, pets and optional address.
 * - createCustomerAddressAction / updateCustomerAddressAction / deleteCustomerAddressAction / setDefaultCustomerAddressAction: manages saved addresses.
 * - createTaskAction / updateTaskStatusAction: manages operational tasks.
 * - transitionBookingAction / updatePetJobStatusAction: advances grooming work.
 * - setDispatchStageAction: advances a home-service booking's dispatch stage (scheduled/en_route/arrived/in_service), independent of bookings.status.
 * - uploadGroomingEvidenceAction / deleteGroomingEvidenceAction: stores/retracts private, booking-linked grooming evidence for an assigned groomer.
 * - updateGroomingChecklistAction / issueInvoiceForBookingAction / previewInvoiceDiscountsAction: closes the service-to-cash loop, including section-22 invoice/pet/service/category discounts, transport fee, and a pre-issuance preview.
 * - createServiceAction / updateServiceAction / overrideGroomingLinePriceAction / createResourceAction / updateResourceAction / archiveResourceAction: configures the operating catalog.
 * - createPackageAction / updatePackageAction: configures the package/membership catalog (recurrence, per-pet, sessions, price, validity) -- future sales only, never rewrites already-sold customer_packages.
 * - renewCustomerPackageAction: manual paid renewal -- creates a renewal invoice/order/ledger row, not just a session top-up, bound to a fresh preview's terms_fingerprint.
 * - updateCustomerPackageTermsAction: guarded correction of a purchased membership's expires_at/pet/service, revision-checked and audited (never a balance/invoice edit).
 * - loadMembershipHistoryAction: read-only ledger + reservation history for one membership (section 25 detail view).
 * - adjustInventoryAction: appends an inventory adjustment movement.
 * - recordPaymentAction / recordExpenseAction: records manual financial activity.
 * - setCustomerNextDiscountAction / revokeCustomerNextDiscountAction: manages a customer's one-use next-booking offer.
 * - Payroll lifecycle (sections 32-33) lives in @/app/payroll/payroll-actions, not here.
 */
import "server-only";

import { revalidatePath } from "next/cache";

import { loadAuthContext } from "@/lib/auth-context";
import { loadCapabilities } from "@/lib/authorization";
import { INVOICE_DISCOUNT_CATEGORIES } from "@/lib/invoice-discount-categories";
import { canonicalRegionNames, type RegionNames } from "@/lib/indonesia-regions";
import { HOMEPAW_STARTER_SERVICES, starterServiceRow } from "@/lib/homepaw-starter";
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
function addressFields(formData: FormData, existingRegion?: RegionNames): AddressFieldValues | AddressFieldsInvalid | null {
  const line1 = textValue(formData, "line1", 200);
  if (!line1) {
    const hasOtherAddressData = ["line2", "rt", "rw", "kelurahan", "province", "kabupatenKota", "kecamatan", "postalCode", "landmark", "accessNotes", "latitude", "longitude"].some((key) => String(formData.get(key) ?? "").trim());
    return hasOtherAddressData ? { invalid: "Isi nama jalan dan nomor rumah agar alamat dapat disimpan" } : null;
  }
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
  const requestedRegion: RegionNames = {
    province: textValue(formData, "province", 100),
    kabupatenKota: textValue(formData, "kabupatenKota", 100),
    kecamatan: textValue(formData, "kecamatan", 100),
  };
  const region = canonicalRegionNames(requestedRegion)
    ?? (existingRegion && Object.entries(requestedRegion).every(([key, value]) => existingRegion[key as keyof RegionNames] === value) ? existingRegion : null);
  if (!region) return { invalid: "Pilih provinsi, kabupaten/kota, dan kecamatan dari daftar" };
  return {
    label: textValue(formData, "label", 60) || "Rumah",
    recipient_name: textValue(formData, "recipientName", 120) || null,
    recipient_phone: recipientPhone || null,
    line1,
    line2: textValue(formData, "line2", 200) || null,
    rt: textValue(formData, "rt", 10) || null,
    rw: textValue(formData, "rw", 10) || null,
    kelurahan: textValue(formData, "kelurahan", 100) || null,
    kecamatan: region.kecamatan,
    kabupaten_kota: region.kabupatenKota,
    province: region.province,
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
  if (name.length < 2) return databaseError("Pelanggan", "nama wajib diisi");
  let pets: Array<{ name: string; species: string; breed: string; size: string; weightKg: string; color: string; age: string; notes: string }>;
  try {
    pets = JSON.parse(textValue(formData, "petsJson", 20_000)) as typeof pets;
  } catch { return databaseError("Pet", "data pet tidak valid"); }
  const [petTypesResult, dogBandsResult] = await Promise.all([
    context.supabase.from("organization_pet_types").select("key").eq("organization_id", context.organizationId).eq("is_active", true),
    context.supabase.from("organization_dog_size_bands").select("key").eq("organization_id", context.organizationId),
  ]);
  if (petTypesResult.error || dogBandsResult.error) return databaseError("Pet", "jenis atau ukuran pet belum dapat diperiksa");
  const allowedPetTypes = new Set((petTypesResult.data ?? []).map((type) => type.key));
  const allowedDogBands = new Set((dogBandsResult.data ?? []).map((band) => band.key));
  if (!Array.isArray(pets) || pets.length < 1 || pets.length > 5 || pets.some((pet) =>
    !pet || typeof pet.name !== "string" || !pet.name.trim() || pet.name.length > 80
    || !allowedPetTypes.has(pet.species)
    || (pet.size !== "" && !allowedDogBands.has(pet.size))
    || (pet.species !== "dog" && pet.size !== "")
    || (pet.weightKg && (!Number.isFinite(Number(pet.weightKg)) || Number(pet.weightKg) <= 0))
  )) return databaseError("Pet", "isi satu hingga lima pet dengan nama dan jenis yang valid");

  const address = addressFields(formData);
  if (address && "invalid" in address) return databaseError("Alamat", address.invalid);

  const { error } = await context.supabase.schema("app").rpc("create_customer_household", {
    p_name: name,
    p_phone: phone || null,
    p_pets: pets.map((pet) => ({ ...pet, name: pet.name.trim(), weightKg: pet.weightKg || null })),
    p_address: address,
  });
  if (error) return databaseError("Pelanggan gagal dibuat", error.message);
  revalidatePath("/customers"); revalidatePath("/bookings"); revalidatePath("/dashboard");
  return { error: null, success: `${name} dan ${pets.length} pet berhasil ditambahkan.` };
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
  const { data: currentAddress } = await context.supabase.from("customer_addresses")
    .select("province,kabupaten_kota,kecamatan")
    .eq("organization_id", context.organizationId).eq("customer_id", customerId).eq("id", addressId).maybeSingle();
  if (!currentAddress) return databaseError("Alamat", "alamat tidak ditemukan");
  const address = addressFields(formData, {
    province: currentAddress.province ?? "",
    kabupatenKota: currentAddress.kabupaten_kota ?? "",
    kecamatan: currentAddress.kecamatan ?? "",
  });
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

/**
 * Retracts a grooming evidence photo through app.delete_grooming_evidence
 * (section 28), which re-checks the same job-assignment rule as upload (or
 * evidence.read_all/booking.delete for a manager). The DB row is soft-deleted
 * FIRST, then the storage object is removed - never the reverse, which would
 * leave a live signed URL pointing at nothing.
 */
export async function deleteGroomingEvidenceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace();
  if (!context) return databaseError("Foto", "sesi atau workspace aktif tidak tersedia");
  const attachmentId = idValue(formData, "attachmentId");
  if (!attachmentId) return databaseError("Foto", "ID foto tidak valid");
  const result = await context.supabase.schema("app").rpc("delete_grooming_evidence", { p_attachment: attachmentId });
  if (result.error) {
    if (/not_authorized/.test(result.error.message)) return databaseError("Foto", "Anda tidak memiliki akses untuk menghapus foto ini");
    if (/attachment_not_found/.test(result.error.message)) return databaseError("Foto", "foto tidak ditemukan");
    console.error("delete_grooming_evidence RPC failed", { code: result.error.code, message: result.error.message });
    return databaseError("Foto", "server tidak dapat menghapus foto. Coba lagi.");
  }
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (row?.storage_bucket && row?.storage_path) {
    await context.supabase.storage.from(row.storage_bucket).remove([row.storage_path]);
  }
  revalidatePath("/my-schedule"); revalidatePath("/operations");
  return { error: null, success: "Foto berhasil dihapus." };
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

function invoiceLevelDiscount(formData: FormData): { type: string; value: number; basicGroomingOnly: boolean } | null {
  const type = textValue(formData, "invoiceDiscountType", 10);
  if (type !== "percent" && type !== "fixed") return null;
  const value = numberValue(formData, "invoiceDiscountValue");
  if (value === null || value <= 0) return null;
  return { type, value, basicGroomingOnly: formData.get("invoiceDiscountBasicOnly") === "on" };
}

function categoryDiscounts(formData: FormData): Array<{ category: string; type: string; value: number }> {
  const rules: Array<{ category: string; type: string; value: number }> = [];
  for (const [slug, label] of INVOICE_DISCOUNT_CATEGORIES) {
    const type = textValue(formData, `categoryDiscountType_${slug}`, 10);
    if (type !== "percent" && type !== "fixed") continue;
    const value = numberValue(formData, `categoryDiscountValue_${slug}`);
    if (value === null || value <= 0) continue;
    rules.push({ category: label, type, value });
  }
  return rules;
}

/** Reads parallel getAll() arrays (one row per pet/service the staff set a discount on) into typed rule objects. */
function keyedDiscounts(formData: FormData, idKey: string, typeKey: string, valueKey: string, idField: string): Array<Record<string, string | number>> {
  const ids = formData.getAll(idKey).map(String);
  const types = formData.getAll(typeKey).map(String);
  const values = formData.getAll(valueKey).map(String);
  const rules: Array<Record<string, string | number>> = [];
  for (let i = 0; i < ids.length; i += 1) {
    const type = types[i]; const value = Number(values[i]);
    if (!ids[i] || (type !== "percent" && type !== "fixed") || !Number.isFinite(value) || value <= 0) continue;
    rules.push({ [idField]: ids[i], type, value });
  }
  return rules;
}

function invoiceDiscountInputs(formData: FormData) {
  return {
    invoice: invoiceLevelDiscount(formData),
    pets: keyedDiscounts(formData, "petDiscountId", "petDiscountType", "petDiscountValue", "grooming_job_pet_id"),
    services: keyedDiscounts(formData, "serviceDiscountId", "serviceDiscountType", "serviceDiscountValue", "service_id"),
    categories: categoryDiscounts(formData),
  };
}

/**
 * Issues an invoice for a completed booking. All pricing -- package coverage, the
 * complimentary next-appointment offer, the booking-time category rules, and the new
 * section-22 invoice/pet/service/category discounts and transport fee -- is resolved
 * and written atomically by app.issue_invoice_for_booking; nothing here trusts a
 * client-supplied amount, only discount RULES (type/value/target), each range-checked
 * again inside the RPC.
 */
export async function issueInvoiceForBookingAction(formData: FormData) {
  const context = await workspace(); if (!context) return;
  if (!(await loadCapabilities(context.supabase))["invoice.issue"]) return;
  const bookingId = idValue(formData, "bookingId"); if (!bookingId) return;
  const invoiceDate = textValue(formData, "invoiceDate", 10);
  const dueDate = textValue(formData, "dueDate", 10);
  if ((invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) || (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) return;
  const issuedAt = invoiceDate ? new Date(`${invoiceDate}T09:00:00+07:00`) : null;
  const dueAt = dueDate ? new Date(`${dueDate}T23:59:59+07:00`) : null;
  if ((issuedAt && Number.isNaN(issuedAt.getTime())) || (dueAt && Number.isNaN(dueAt.getTime()))) return;
  const documentType = textValue(formData, "documentType", 30);
  if (documentType && !["auto", "invoice", "service_report"].includes(documentType)) return;
  const discounts = invoiceDiscountInputs(formData);
  const result = await context.supabase.schema("app").rpc("issue_invoice_for_booking", {
    p_booking: bookingId, p_invoice_discount: discounts.invoice, p_pet_discounts: discounts.pets,
    p_service_discounts: discounts.services, p_category_discounts: discounts.categories,
    p_issued_at: issuedAt?.toISOString() ?? null, p_due_at: dueAt?.toISOString() ?? null,
    p_document_type: documentType === "auto" ? null : documentType || null,
    p_groomer: idValue(formData, "groomerId"), p_manual_groomer: textValue(formData, "manualGroomer", 160) || null,
    p_admin_notes: textValue(formData, "adminNotes", 2000) || null,
  });
  if (result.error) { console.error("issue_invoice_failed", result.error); return; }
  revalidatePath("/operations"); revalidatePath("/finance"); revalidatePath("/reports");
}

export interface InvoicePreviewLine {
  lineId: string | null; name: string; quantity: number; unitPrice: number; gross: number;
  discountAmount: number; lineTotal: number; category: string; pricingBreakdown: Record<string, unknown>;
}
export interface InvoicePreview { lines: InvoicePreviewLine[]; transportFee: number; subtotal: number; discountTotal: number; total: number }
export interface InvoicePreviewResult { error: string | null; preview: InvoicePreview | null }

/** Read-only: lets staff see exactly what issuing would produce before committing (section 22, item 8). */
export async function previewInvoiceDiscountsAction(formData: FormData): Promise<InvoicePreviewResult> {
  const context = await workspace(); if (!context) return { error: "workspace aktif tidak tersedia", preview: null };
  const bookingId = idValue(formData, "bookingId"); if (!bookingId) return { error: "booking tidak valid", preview: null };
  const discounts = invoiceDiscountInputs(formData);
  const result = await context.supabase.schema("app").rpc("preview_invoice_pricing", {
    p_booking: bookingId, p_invoice_discount: discounts.invoice, p_pet_discounts: discounts.pets,
    p_service_discounts: discounts.services, p_category_discounts: discounts.categories,
  });
  if (result.error) return { error: result.error.message, preview: null };
  const data = result.data as { lines: Array<Record<string, unknown>>; transport_fee: number; subtotal: number; discount_total: number; total: number };
  return {
    error: null,
    preview: {
      lines: data.lines.map((line) => ({
        lineId: (line.line_id as string | null) ?? null, name: String(line.name), quantity: Number(line.quantity), unitPrice: Number(line.unit_price),
        gross: Number(line.gross), discountAmount: Number(line.discount_amount), lineTotal: Number(line.line_total), category: String(line.category),
        pricingBreakdown: (line.pricing_breakdown as Record<string, unknown>) ?? {},
      })),
      transportFee: Number(data.transport_fee), subtotal: Number(data.subtotal), discountTotal: Number(data.discount_total), total: Number(data.total),
    },
  };
}

const SERVICE_SIZE_KEYS = ["extraSmall", "small", "medium", "large", "extraLarge", "cat"] as const;
const SERVICE_SIZE_COLUMNS: Record<(typeof SERVICE_SIZE_KEYS)[number], string> = {
  extraSmall: "price_extra_small", small: "price_small", medium: "price_medium", large: "price_large", extraLarge: "price_extra_large", cat: "price_cat",
};
const SERVICE_DURATION_COLUMNS: Record<(typeof SERVICE_SIZE_KEYS)[number], string> = {
  extraSmall: "duration_extra_small", small: "duration_small", medium: "duration_medium", large: "duration_large", extraLarge: "duration_extra_large", cat: "duration_cat",
};
const FULFILLMENT_MODES = new Set(["home", "in_store"]);

/** Blank means "no override for this size" (falls back to base_price); numberValue() would coerce blank to 0. */
function optionalPriceValue(formData: FormData, key: string): number | null | "invalid" {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : "invalid";
}

interface ServicePriceMatrix { price_extra_small: number | null; price_small: number | null; price_medium: number | null; price_large: number | null; price_extra_large: number | null; price_cat: number | null }

const LEGACY_DOG_FIELDS: Record<string, string> = { extra_small: "extraSmall", small: "small", medium: "medium", large: "large", extra_large: "extraLarge" };
async function serviceDogSizePricing(context: { supabase: Awaited<ReturnType<typeof createClient>>; organizationId: string }, formData: FormData, zeroTime: boolean) {
  const bands = await context.supabase.from("organization_dog_size_bands").select("key").eq("organization_id", context.organizationId);
  if (bands.error) return { invalid: "kategori ukuran belum dapat dimuat" };
  const matrix: Record<string, { price: number | null; duration: number | null }> = {};
  for (const band of bands.data ?? []) {
    const suffix = LEGACY_DOG_FIELDS[band.key] ?? `band_${band.key}`;
    const price = optionalPriceValue(formData, `price_${suffix}`);
    const rawDuration = String(formData.get(`duration_${suffix}`) ?? "").trim();
    const duration = !rawDuration || zeroTime ? null : Number(rawDuration);
    if (price === "invalid" || (duration !== null && (!Number.isInteger(duration) || duration < 15 || duration > 1440))) {
      return { invalid: `harga atau durasi ukuran ${band.key} tidak valid` };
    }
    matrix[band.key] = { price, duration };
  }
  return { matrix };
}

function servicePriceMatrix(formData: FormData): ServicePriceMatrix | { invalid: string } {
  const matrix: Record<string, number | null> = {};
  for (const key of SERVICE_SIZE_KEYS) {
    const value = optionalPriceValue(formData, `price_${key}`);
    if (value === "invalid") return { invalid: `harga untuk ukuran ${key} tidak valid` };
    matrix[SERVICE_SIZE_COLUMNS[key]] = value;
  }
  return matrix as unknown as ServicePriceMatrix;
}

function serviceDurationMatrix(formData: FormData, zeroTime: boolean): { matrix: Record<string, number | null> } | { invalid: string } {
  const matrix: Record<string, number | null> = {};
  for (const key of SERVICE_SIZE_KEYS) {
    const raw = String(formData.get(`duration_${key}`) ?? "").trim();
    if (!raw || zeroTime) { matrix[SERVICE_DURATION_COLUMNS[key]] = null; continue; }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 15 || value > 1440) return { invalid: `durasi untuk ukuran ${key} tidak valid` };
    matrix[SERVICE_DURATION_COLUMNS[key]] = value;
  }
  return { matrix };
}

function serviceFulfillmentModes(formData: FormData): string[] {
  const modes = formData.getAll("fulfillmentModes").map((value) => String(value)).filter((value) => FULFILLMENT_MODES.has(value));
  return modes.length ? [...new Set(modes)] : ["home", "in_store"];
}

/** Free-text categories are tenant-defined and used by invoice discount rules. */
function serviceCategory(formData: FormData): string | null | "invalid" {
  const value = textValue(formData, "category", 40);
  return !value ? null : /^[\p{L}\p{N}][\p{L}\p{N} &/()+.\-]{0,39}$/u.test(value) ? value : "invalid";
}

function serviceSpeciesPricing(formData: FormData, zeroTime: boolean): { matrix: Record<string, { price: number; duration: number }> } | { invalid: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(textValue(formData, "speciesPricingJson", 10_000) || "{}"); }
  catch { return { invalid: "harga jenis pet tidak valid" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 30) return { invalid: "harga jenis pet tidak valid" };
  const result: Record<string, { price: number; duration: number }> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(key) || ["dog", "cat"].includes(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) return { invalid: "jenis pet tidak valid" };
    const entry = raw as Record<string, unknown>;
    if (typeof entry.price !== "number" || (!zeroTime && typeof entry.duration !== "number")) return { invalid: `isi harga dan durasi ${key}` };
    const price = entry.price, duration = zeroTime ? 0 : Number(entry.duration);
    if (!Number.isFinite(price) || price < 0 || price > 999999999 || !Number.isInteger(duration) || duration < 0 || duration > 1440) return { invalid: `harga/durasi ${key} tidak valid` };
    result[key] = { price, duration };
  }
  return { matrix: result };
}

export async function createServiceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["service.manage"]) return databaseError("Layanan", "izin service.manage diperlukan");
  const name = textValue(formData, "name", 100); const zeroTime = formData.get("zeroTimeAddon") === "on"; const duration = zeroTime ? 0 : numberValue(formData, "duration"); const price = numberValue(formData, "price");
  const additionalDuration = zeroTime ? 0 : numberValue(formData, "additionalDuration") ?? 0;
  if (name.length < 2 || duration === null || (!zeroTime && duration < 15) || price === null || price < 0 || additionalDuration < 0) return databaseError("Layanan", "nama, durasi, atau harga tidak valid");
  const priceMatrix = servicePriceMatrix(formData);
  if ("invalid" in priceMatrix) return databaseError("Layanan", priceMatrix.invalid);
  const durationMatrix = serviceDurationMatrix(formData, zeroTime);
  if ("invalid" in durationMatrix) return databaseError("Layanan", durationMatrix.invalid);
  const dogPricing = await serviceDogSizePricing(context, formData, zeroTime);
  if ("invalid" in dogPricing) return databaseError("Layanan", dogPricing.invalid ?? "matriks ukuran tidak valid");
  const category = serviceCategory(formData), speciesPricing = serviceSpeciesPricing(formData, zeroTime);
  if (category === "invalid") return databaseError("Layanan", "kategori layanan tidak valid");
  if ("invalid" in speciesPricing) return databaseError("Layanan", speciesPricing.invalid);
  const { error } = await context.supabase.from("service_catalog").insert({ organization_id: context.organizationId, name, category, duration_minutes: duration, additional_duration_minutes: additionalDuration, base_price: price, currency: "IDR", required_photos: 2, fulfillment_modes: serviceFulfillmentModes(formData), dog_size_pricing: dogPricing.matrix, species_pricing: speciesPricing.matrix, metadata: { created_from: "homepaw_pilot" }, ...priceMatrix, ...durationMatrix.matrix });
  if (error) return databaseError("Layanan gagal dibuat", error.message);
  revalidatePath("/catalog"); revalidatePath("/bookings"); return { error: null, success: "Layanan berhasil ditambahkan." };
}

export async function updateServiceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["service.manage"]) return databaseError("Layanan", "izin service.manage diperlukan");
  const serviceId = idValue(formData, "serviceId"); if (!serviceId) return databaseError("Layanan", "layanan tidak valid");
  const name = textValue(formData, "name", 100); const zeroTime = formData.get("zeroTimeAddon") === "on"; const duration = zeroTime ? 0 : numberValue(formData, "duration"); const price = numberValue(formData, "price");
  const additionalDuration = zeroTime ? 0 : numberValue(formData, "additionalDuration") ?? 0;
  if (name.length < 2 || duration === null || (!zeroTime && duration < 15) || price === null || price < 0 || additionalDuration < 0) return databaseError("Layanan", "nama, durasi, atau harga tidak valid");
  const priceMatrix = servicePriceMatrix(formData);
  if ("invalid" in priceMatrix) return databaseError("Layanan", priceMatrix.invalid);
  const durationMatrix = serviceDurationMatrix(formData, zeroTime);
  if ("invalid" in durationMatrix) return databaseError("Layanan", durationMatrix.invalid);
  const dogPricing = await serviceDogSizePricing(context, formData, zeroTime);
  if ("invalid" in dogPricing) return databaseError("Layanan", dogPricing.invalid ?? "matriks ukuran tidak valid");
  const category = serviceCategory(formData), speciesPricing = serviceSpeciesPricing(formData, zeroTime);
  if (category === "invalid") return databaseError("Layanan", "kategori layanan tidak valid");
  if ("invalid" in speciesPricing) return databaseError("Layanan", speciesPricing.invalid);
  const isActive = formData.get("isActive") === "on";
  const { error } = await context.supabase.from("service_catalog").update({ name, category, duration_minutes: duration, additional_duration_minutes: additionalDuration, base_price: price, fulfillment_modes: serviceFulfillmentModes(formData), dog_size_pricing: dogPricing.matrix, species_pricing: speciesPricing.matrix, is_active: isActive, ...priceMatrix, ...durationMatrix.matrix }).eq("organization_id", context.organizationId).eq("id", serviceId);
  if (error) return databaseError("Layanan gagal diperbarui", error.message);
  revalidatePath("/catalog"); revalidatePath("/bookings"); return { error: null, success: "Layanan berhasil diperbarui." };
}

export async function addPetTypeAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["service.manage"]) return databaseError("Jenis pet", "izin service.manage diperlukan");
  const label = textValue(formData, "label", 60);
  const key = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30);
  if (label.length < 2 || !/^[a-z][a-z0-9_]{1,29}$/.test(key)) return databaseError("Jenis pet", "nama harus menghasilkan kode huruf minimal dua karakter");
  const result = await context.supabase.schema("app").rpc("set_org_pet_type", { p_org: context.organizationId, p_key: key, p_label: label, p_active: true });
  if (result.error) return databaseError("Jenis pet", "jenis baru belum dapat disimpan");
  revalidatePath("/catalog"); revalidatePath("/customers"); revalidatePath("/bookings");
  return { error: null, success: `${label} siap. Atur harga dan durasi tiap layanan sebelum menerima booking.` };
}

/** Opt-in starter import: only missing names are inserted in the active tenant.
 * Existing catalog rows (including owner edits) and sold snapshots stay intact.
 */
export async function importHomepawServicesAction(_previous: PilotActionState, _formData: FormData): Promise<PilotActionState> {
  void _previous; void _formData;
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["service.manage"]) return databaseError("Template", "izin service.manage diperlukan");
  const rows = HOMEPAW_STARTER_SERVICES.map((item) => starterServiceRow(context.organizationId, item));
  const { error } = await context.supabase.from("service_catalog").upsert(rows, { onConflict: "organization_id,name", ignoreDuplicates: true });
  if (error) return databaseError("Template gagal ditambahkan", error.message);
  revalidatePath("/catalog"); revalidatePath("/schedule");
  return { error: null, success: "Template ditambahkan untuk layanan yang belum ada. Harga dan durasi layanan lama tidak diubah; semua nilai dapat diedit di bawah." };
}

export async function overrideGroomingLinePriceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const lineId = idValue(formData, "lineId"); const price = numberValue(formData, "price");
  const reason = textValue(formData, "reason", 300);
  if (!lineId || price === null || price < 0) return databaseError("Harga layanan", "harga tidak valid");
  if (reason.length < 3) return databaseError("Harga layanan", "alasan override wajib diisi");
  const result = await context.supabase.schema("app").rpc("override_grooming_line_price", { p_line: lineId, p_price: price, p_reason: reason });
  if (result.error) return databaseError("Harga tidak dapat diubah", /insufficient_privilege|42501/i.test(result.error.message) ? "izin service.manage diperlukan" : result.error.message);
  revalidatePath("/operations"); revalidatePath("/finance");
  return { error: null, success: "Harga layanan berhasil diperbarui." };
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

const paymentProofMimeExtensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Errors record_payment raises deliberately (the request definitely did not
// commit) — safe to report as a plain rejection and, if we freshly uploaded
// a proof this call, safe to clean it up. Anything NOT in this list is
// treated as ambiguous/transport-shaped: we do not know whether the RPC
// committed before the response was lost, so we check for real instead of
// guessing either way.
const PAYMENT_RPC_KNOWN_REJECTIONS = [
  /proof_required_for_bank_transfer/, /invoice_already_paid/, /invoice_void/, /invoice_zero_due/,
  /invalid_method/, /invalid_amount/, /invoice_not_found/, /not_authorized/,
  /proof_attachment_not_linked_to_invoice/, /request_key_reused_with_different_inputs/,
];

function mapPaymentRpcError(message: string): string {
  if (/proof_required_for_bank_transfer/.test(message)) return "transfer bank wajib menyertakan bukti screenshot";
  if (/invoice_already_paid/.test(message)) return "invoice ini sudah lunas";
  if (/invoice_void/.test(message)) return "invoice ini sudah dibatalkan";
  if (/invoice_zero_due/.test(message)) return "invoice ini tidak memiliki tagihan";
  if (/not_authorized/.test(message)) return "Anda tidak memiliki akses ke cabang invoice ini";
  if (/request_key_reused_with_different_inputs/.test(message)) return "permintaan ini sudah pernah dikirim dengan data berbeda — muat ulang halaman";
  return "server tidak dapat mencatat pembayaran. Coba lagi.";
}

type ProofResult = { id: string; storagePath: string; freshlyUploaded: boolean } | { error: string } | null;

/**
 * Uploads (or reuses) the proof for ONE logical payment submission. The
 * storage path is DETERMINISTIC from requestKey — `${org}/payments/${requestKey}.ext`
 * — so a genuine retry of the same submission always resolves to the SAME
 * object and the SAME attachments/attachment_links rows instead of
 * uploading a fresh, orphaned copy every attempt (which is what made
 * app.record_payment's changed-input detection reject legitimate retries:
 * a new random attachment id every submission looks like a changed input).
 * If a prior attempt already got the attachment row (or even just the
 * upload) done, this reuses it and never re-uploads or re-links.
 */
async function ensurePaymentProof(
  context: { supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never; organizationId: string; userId: string },
  invoiceId: string, requestKey: string, proofFile: FormDataEntryValue | null,
): Promise<ProofResult> {
  if (!(proofFile instanceof File) || proofFile.size === 0) return null;
  const extension = paymentProofMimeExtensions[proofFile.type];
  if (!extension) return { error: "format harus JPG, PNG, atau WebP" };
  if (proofFile.size > 4 * 1024 * 1024) return { error: "ukuran maksimum 4 MB" };
  const storagePath = `${context.organizationId}/payments/${requestKey}.${extension}`;

  const existing = await context.supabase.from("attachments").select("id").eq("organization_id", context.organizationId).eq("storage_path", storagePath).is("deleted_at", null).maybeSingle();
  let attachmentId: string;
  let freshlyUploaded = false;
  if (existing.data) {
    attachmentId = existing.data.id;
  } else {
    const upload = await context.supabase.storage.from("attachments").upload(storagePath, proofFile, { contentType: proofFile.type, upsert: true });
    if (upload.error) return { error: `gagal diunggah: ${upload.error.message}` };
    const attachment = await context.supabase.from("attachments").insert({
      organization_id: context.organizationId, storage_bucket: "attachments", storage_path: storagePath,
      filename: proofFile.name.slice(0, 200) || `bukti.${extension}`, mime_type: proofFile.type, size_bytes: proofFile.size,
      uploaded_by: context.userId, metadata: { category: "payment_proof" },
    }).select("id").single();
    if (attachment.error || !attachment.data) {
      await context.supabase.storage.from("attachments").remove([storagePath]);
      return { error: "metadata gagal disimpan" };
    }
    attachmentId = attachment.data.id;
    freshlyUploaded = true;
  }
  // Idempotent regardless of whether the attachment row is new or reused —
  // covers the partial-failure case where a prior attempt created the
  // attachment but died before linking it.
  const link = await context.supabase.from("attachment_links").upsert(
    { organization_id: context.organizationId, attachment_id: attachmentId, subject_type: "invoice", subject_id: invoiceId },
    { onConflict: "attachment_id,subject_type,subject_id", ignoreDuplicates: true },
  );
  if (link.error) return { error: `gagal ditautkan ke invoice: ${link.error.message}` };
  return { id: attachmentId, storagePath, freshlyUploaded };
}

/**
 * Calls app.record_payment and, on an error record_payment did NOT raise
 * deliberately, checks whether the payment actually committed before
 * reporting failure — a lost response must never be treated as "definitely
 * did not happen" when it might have, because the caller (recordPaymentAction)
 * uses "definitely did not happen" as the ONLY condition under which it is
 * safe to delete a freshly-uploaded proof.
 */
async function callRecordPayment(
  context: { supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never; organizationId: string },
  args: { invoiceId: string; method: string; amount: number; proofAttachmentId: string | null; requestKey: string },
): Promise<{ payment: Record<string, unknown>; recovered: boolean } | { error: string; ambiguous: boolean }> {
  const result = await context.supabase.schema("app").rpc("record_payment", {
    p_invoice: args.invoiceId, p_method: args.method, p_amount: args.amount,
    p_external_ref: `MANUAL-${args.requestKey}`, // deterministic: stable across retries of the same requestKey
    p_proof_attachment: args.proofAttachmentId, p_request_key: args.requestKey,
  });
  if (!result.error) return { payment: result.data as Record<string, unknown>, recovered: false };

  const message = result.error.message;
  if (PAYMENT_RPC_KNOWN_REJECTIONS.some((re) => re.test(message))) return { error: message, ambiguous: false };

  const recovered = await context.supabase.from("payments").select("*").eq("organization_id", context.organizationId).eq("request_key", args.requestKey).maybeSingle();
  if (recovered.data) return { payment: recovered.data, recovered: true };
  return { error: message, ambiguous: true };
}

async function cleanupRejectedProof(context: { supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never; organizationId: string }, proof: ProofResult) {
  if (!proof || "error" in proof || !proof.freshlyUploaded) return;
  await context.supabase.from("attachment_links").delete().eq("organization_id", context.organizationId).eq("attachment_id", proof.id);
  await context.supabase.from("attachments").delete().eq("organization_id", context.organizationId).eq("id", proof.id);
  await context.supabase.storage.from("attachments").remove([proof.storagePath]);
}

/**
 * Records a payment through app.record_payment (section 29). Direct inserts into
 * `payments` are revoked at the privilege layer (20260928100000_payment_control_workflow.sql)
 * so this RPC is now the only way to record one. `requestKey` is generated once
 * per logical submission (PaymentForm regenerates it only after an ACKNOWLEDGED
 * success — see pilot-forms.tsx) and resubmitted unchanged on retry; every value
 * derived from it (external_ref, the proof's storage path) is deterministic for
 * the SAME reason: a retry must look identical to the RPC, not like a new,
 * conflicting request.
 */
export async function recordPaymentAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const invoiceId = idValue(formData, "invoiceId"); const amount = numberValue(formData, "amount"); const method = textValue(formData, "method", 30);
  const requestKey = idValue(formData, "requestKey");
  if (!invoiceId || !amount || amount <= 0 || !["cash", "card", "wallet", "bank_transfer", "other"].includes(method) || !requestKey) {
    return databaseError("Pembayaran", "data tidak valid");
  }

  const proof = await ensurePaymentProof(context, invoiceId, requestKey, formData.get("proof"));
  if (proof && "error" in proof) return databaseError("Bukti transfer", proof.error);

  const outcome = await callRecordPayment(context, { invoiceId, method, amount, proofAttachmentId: proof?.id ?? null, requestKey });
  if ("error" in outcome) {
    if (!outcome.ambiguous) await cleanupRejectedProof(context, proof);
    return databaseError("Pembayaran", mapPaymentRpcError(outcome.error));
  }
  revalidatePath("/finance"); revalidatePath("/dashboard"); revalidatePath("/reports");
  return { error: null, success: outcome.recovered ? "Pembayaran ini sebelumnya sudah berhasil dicatat (dipulihkan setelah koneksi sempat terputus)." : "Pembayaran berhasil dicatat." };
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
 * Section 24/25 package/membership lifecycle actions. All three call a
 * SECURITY DEFINER RPC that re-authorizes itself (membership.manage) and is
 * idempotent via a client-generated request_key, matching the
 * create_package_invoice convention already used for package sales.
 */
export interface PackageRenewalPreview {
  customerPackageId: string; packageId: string; packageName: string; price: number; currency: string;
  sessionsToAdd: number; rolloverPolicy: string; recurrenceInterval: string; petId: string | null; serviceId: string | null;
  currentAvailable: number; sessionsDiscardedIfRenewed: number; resultingAvailable: number;
  currentExpiresAt: string | null; resultingExpiresAt: string; catalogActive: boolean; membershipStatus: string;
  petScopeIncompatible: boolean; serviceScopeIncompatible: boolean; incompatible: boolean; blockingReason: string | null;
  termsFingerprint: string; generatedAt: string;
}
export interface PackageRenewalPreviewResult { error: string | null; preview: PackageRenewalPreview | null }

/**
 * Section 24, read-only: shows exactly what a renewal would do (price,
 * sessions, currency, pet/service scope, resulting expiry) and whether the
 * catalog's terms have drifted incompatibly since this membership was sold
 * -- BEFORE the staff member commits to issuing the renewal invoice. Also
 * returns termsFingerprint, which the actual renewal write must present
 * unchanged (see renewCustomerPackageAction) -- a stale fingerprint means
 * the catalog/entitlement changed since this preview was generated and the
 * staff member must reload it before submitting.
 */
export async function previewPackageRenewalAction(customerPackageId: string): Promise<PackageRenewalPreviewResult> {
  const context = await workspace(); if (!context) return { error: "workspace aktif tidak tersedia", preview: null };
  if (!UUID.test(customerPackageId)) return { error: "paket tidak valid", preview: null };
  const result = await context.supabase.schema("app").rpc("preview_package_renewal", { p_customer_package: customerPackageId });
  if (result.error) return { error: result.error.message, preview: null };
  const data = result.data as Record<string, unknown>;
  let sizeMismatch = false;
  if (data.pet_id && data.package_id) {
    const [catalog, pet] = await Promise.all([
      context.supabase.from("packages").select("size_band").eq("organization_id", context.organizationId).eq("id", String(data.package_id)).maybeSingle(),
      context.supabase.from("pets").select("species,size,weight_kg").eq("organization_id", context.organizationId).eq("id", String(data.pet_id)).maybeSingle(),
    ]);
    if (catalog.data?.size_band && pet.data) sizeMismatch = pricingBand({ species: pet.data.species, size: pet.data.size, weightKg: pet.data.weight_kg }) !== catalog.data.size_band;
  }
  return {
    error: null,
    preview: {
      customerPackageId: String(data.customer_package_id), packageId: String(data.package_id), packageName: String(data.package_name),
      price: Number(data.price), currency: String(data.currency), sessionsToAdd: Number(data.sessions_to_add),
      rolloverPolicy: String(data.rollover_policy), recurrenceInterval: String(data.recurrence_interval),
      petId: data.pet_id ? String(data.pet_id) : null, serviceId: data.service_id ? String(data.service_id) : null,
      currentAvailable: Number(data.current_available), sessionsDiscardedIfRenewed: Number(data.sessions_discarded_if_renewed),
      resultingAvailable: Number(data.resulting_available), currentExpiresAt: data.current_expires_at ? String(data.current_expires_at) : null,
      resultingExpiresAt: String(data.resulting_expires_at), catalogActive: Boolean(data.catalog_active), membershipStatus: String(data.membership_status),
      petScopeIncompatible: Boolean(data.pet_scope_incompatible), serviceScopeIncompatible: Boolean(data.service_scope_incompatible),
      incompatible: Boolean(data.incompatible) || sizeMismatch, blockingReason: sizeMismatch ? "Ukuran pet sudah berubah; jual paket ukuran baru untuk periode berikutnya." : data.blocking_reason ? String(data.blocking_reason) : null,
      termsFingerprint: String(data.terms_fingerprint), generatedAt: String(data.generated_at),
    },
  };
}

/**
 * A manual renewal is a real commercial transaction: it creates a renewal
 * invoice (order + invoice + invoice_lines) exactly like the original sale,
 * not just a session top-up. Branch is required and explicit -- the UI
 * defaults it to the membership's source-invoice branch when known, but the
 * staff member confirms it; nothing here guesses a branch for a legacy
 * membership with no source invoice. termsFingerprint must come from a
 * freshly-loaded previewPackageRenewalAction result -- the RPC re-validates
 * it under the row lock and refuses a stale one (see the migration).
 */
export async function renewCustomerPackageAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["invoice.issue"]) return databaseError("Paket", "izin invoice.issue diperlukan");
  const customerPackageId = idValue(formData, "customerPackageId"); const branchId = idValue(formData, "branchId"); const requestKey = idValue(formData, "requestKey");
  const termsFingerprint = textValue(formData, "termsFingerprint", 64) || null;
  const issuedDate = textValue(formData, "invoiceDate", 10); const dueDate = textValue(formData, "dueDate", 10);
  if (!customerPackageId || !branchId || !requestKey || !issuedDate) return databaseError("Paket", "cabang, tanggal invoice, dan paket wajib diisi");
  if (!termsFingerprint) return databaseError("Paket", "muat pratinjau perpanjangan terlebih dahulu sebelum mengirim");
  const issuedAt = new Date(`${issuedDate}T09:00:00+07:00`).toISOString();
  const dueAt = dueDate ? new Date(`${dueDate}T23:59:59+07:00`).toISOString() : null;
  if (dueAt && new Date(dueAt) < new Date(issuedAt)) return databaseError("Paket", "tanggal jatuh tempo tidak boleh sebelum tanggal invoice");
  const result = await context.supabase.schema("app").rpc("renew_customer_package", {
    p_customer_package: customerPackageId, p_branch: branchId, p_issued_at: issuedAt, p_due_at: dueAt,
    p_admin_notes: textValue(formData, "adminNotes", 2000) || null, p_request_key: requestKey, p_terms_fingerprint: termsFingerprint,
  });
  if (result.error) return databaseError("Perpanjangan gagal", /insufficient_privilege|42501/i.test(result.error.message) ? "izin membership.manage/invoice.issue diperlukan" : /renewal_terms_changed_since_preview|40001/i.test(result.error.message) ? "syarat paket berubah sejak pratinjau; muat ulang pratinjau dan coba lagi" : /renewal_preview_required/i.test(result.error.message) ? "muat pratinjau perpanjangan terlebih dahulu sebelum mengirim" : /request_key_reused/i.test(result.error.message) ? "kunci permintaan sudah dipakai untuk perpanjangan lain" : /package_canceled_cannot_renew/i.test(result.error.message) ? "paket sudah diarsipkan dan tidak dapat diperpanjang" : /package_catalog_inactive/i.test(result.error.message) ? "produk paket ini sudah tidak aktif di katalog" : /package_size_mismatch_on_renewal/i.test(result.error.message) ? "ukuran pet telah berubah; jual paket ukuran yang sesuai untuk periode berikutnya" : /catalog_terms_changed_incompatible/i.test(result.error.message) ? "syarat katalog sudah berubah dan tidak lagi cocok dengan paket ini; perbarui katalog atau tangani secara manual" : result.error.message);
  const row = result.data as { invoice_number?: string } | null;
  revalidatePath("/programs"); revalidatePath("/programs/memberships"); revalidatePath("/finance");
  return { error: null, success: `Paket diperpanjang. ${row?.invoice_number ?? "Invoice"} diterbitkan.` };
}

export async function updateCustomerPackageTermsAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["membership.manage"]) return databaseError("Paket", "izin membership.manage diperlukan");
  const customerPackageId = idValue(formData, "customerPackageId");
  const revision = numberValue(formData, "revision");
  const reason = textValue(formData, "reason", 300);
  const expiresDate = textValue(formData, "expiresAt", 10);
  const petId = idValue(formData, "petId");
  const serviceId = idValue(formData, "serviceId");
  if (!customerPackageId || revision === null || !Number.isInteger(revision)) return databaseError("Koreksi", "data tidak valid");
  if (reason.length < 3) return databaseError("Koreksi", "alasan koreksi wajib diisi (minimal 3 karakter)");
  const current = await context.supabase.from("customer_packages").select("expires_at")
    .eq("organization_id", context.organizationId).eq("id", customerPackageId).single();
  if (current.error) return databaseError("Koreksi", current.error.message);
  let expiresAt: string | null;
  try { expiresAt = correctedMembershipExpiry(expiresDate, current.data.expires_at); }
  catch { return databaseError("Koreksi", "tanggal kedaluwarsa tidak valid"); }
  const result = await context.supabase.schema("app").rpc("update_customer_package_terms", {
    p_customer_package: customerPackageId, p_revision: revision, p_reason: reason,
    p_expires_at: expiresAt, p_pet: petId, p_service: serviceId,
  });
  if (result.error) return databaseError(
    "Koreksi gagal",
    /insufficient_privilege|42501/i.test(result.error.message) ? "izin membership.manage diperlukan"
    : /stale_correction_request|40001/i.test(result.error.message) ? "data berubah sejak dimuat; muat ulang dan coba lagi"
    : /entitlement_scope_locked_after_first_reservation/i.test(result.error.message) ? "hewan/layanan tidak dapat diubah setelah paket ini pernah dipesan atau dipakai"
    : /entitlement_scope_locked_after_renewal/i.test(result.error.message) ? "hewan/layanan tidak dapat diubah setelah paket ini pernah diperpanjang"
    : /package_canceled_cannot_edit/i.test(result.error.message) ? "paket yang diarsipkan tidak dapat dikoreksi; aktifkan kembali terlebih dahulu"
    : /pet_not_found_for_customer/i.test(result.error.message) ? "hewan tidak ditemukan untuk pelanggan ini"
    : /service_not_found/i.test(result.error.message) ? "layanan tidak ditemukan"
    : /correction_reason_required/i.test(result.error.message) ? "alasan koreksi wajib diisi"
    : result.error.message,
  );
  revalidatePath("/programs"); revalidatePath("/programs/memberships");
  return { error: null, success: "Data paket berhasil dikoreksi." };
}

const RECURRENCE_INTERVALS = new Set(["none", "week", "month", "year"]);
const ROLLOVER_POLICIES = new Set(["none", "rollover"]);

interface PackagePayload {
  name: string; description: string | null; service_id: string | null; total_sessions: number; price: number;
  validity_days: number | null; rollover_policy: string; recurrence_interval: string; per_pet: boolean;
  size_band: string | null; discount_percent: number | null; visit_interval_days: number | null;
}

function packagePayload(formData: FormData): PackagePayload | { invalid: string } {
  const name = textValue(formData, "name", 100);
  const sessions = numberValue(formData, "sessions");
  const price = numberValue(formData, "price");
  const validityDaysText = textValue(formData, "validityDays", 10);
  const validityDays = validityDaysText ? numberValue(formData, "validityDays") : null;
  const recurrenceInterval = textValue(formData, "recurrenceInterval", 10) || "none";
  const rolloverPolicy = textValue(formData, "rolloverPolicy", 10) || "none";
  const serviceId = idValue(formData, "serviceId");
  const perPet = formData.get("perPet") === "on";
  const sizeBand = textValue(formData, "sizeBand", 20) || null;
  const discountText = textValue(formData, "discountPercent", 8);
  const discountPercent = discountText ? numberValue(formData, "discountPercent") : null;
  const visitIntervalText = textValue(formData, "visitIntervalDays", 4);
  const visitIntervalDays = visitIntervalText ? numberValue(formData, "visitIntervalDays") : null;
  const description = textValue(formData, "description", 300) || null;
  if (name.length < 2 || !sessions || sessions < 1 || price === null || price < 0) return { invalid: "nama, jumlah sesi, atau harga tidak valid" };
  if (validityDaysText && (validityDays === null || !Number.isInteger(validityDays) || validityDays < 1)) return { invalid: "masa berlaku tidak valid" };
  if (!RECURRENCE_INTERVALS.has(recurrenceInterval)) return { invalid: "interval perpanjangan tidak valid" };
  if (!ROLLOVER_POLICIES.has(rolloverPolicy)) return { invalid: "kebijakan rollover tidak valid" };
  if (sizeBand && sizeBand !== "cat" && !/^[a-z][a-z0-9_]{1,29}$/.test(sizeBand)) return { invalid: "ukuran paket tidak valid" };
  if (sizeBand && (!perPet || !serviceId)) return { invalid: "paket per ukuran harus terikat pada satu hewan dan layanan" };
  if (discountText && (discountPercent === null || discountPercent < 0 || discountPercent > 100)) return { invalid: "diskon referensi tidak valid" };
  if (visitIntervalText && (visitIntervalDays === null || !Number.isInteger(visitIntervalDays) || visitIntervalDays < 1 || visitIntervalDays > 365)) return { invalid: "jarak antar kunjungan tidak valid" };
  return { name, description, service_id: serviceId, total_sessions: sessions, price, validity_days: validityDays, rollover_policy: rolloverPolicy, recurrence_interval: recurrenceInterval, per_pet: perPet, size_band: sizeBand, discount_percent: discountPercent, visit_interval_days: visitIntervalDays };
}

/**
 * Section 24 catalog configuration: plain RLS-guarded table writes, the same
 * pattern as createServiceAction/updateServiceAction (packages already has a
 * membership.manage write policy -- see 20260721001100_security_rls_capabilities.sql
 * -- so no bespoke RPC is needed for a non-monetary-ledger catalog edit).
 * Editing the catalog only ever changes public.packages; it can never rewrite
 * an already-sold customer_packages row (those snapshot their own pet/service
 * at purchase time), so existing entitlements are untouched by design.
 */
export async function createPackageAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["membership.manage"]) return databaseError("Paket", "izin membership.manage diperlukan");
  const payload = packagePayload(formData);
  if ("invalid" in payload) return databaseError("Paket", payload.invalid);
  if (payload.size_band && payload.size_band !== "cat") {
    const band = await context.supabase.from("organization_dog_size_bands").select("key").eq("organization_id", context.organizationId).eq("key", payload.size_band).maybeSingle();
    if (band.error || !band.data) return databaseError("Paket", "ukuran tidak tersedia untuk bisnis ini");
  }
  if (payload.service_id) {
    const { data: service } = await context.supabase.from("service_catalog").select("id").eq("organization_id", context.organizationId).eq("id", payload.service_id).is("deleted_at", null).maybeSingle();
    if (!service) return databaseError("Paket", "layanan tidak ditemukan");
  }
  const { error } = await context.supabase.from("packages").insert({ organization_id: context.organizationId, ...payload, currency: "IDR", is_active: true, metadata: { created_from: "homepaw_pilot" } });
  if (error) return databaseError("Paket gagal dibuat", error.message);
  revalidatePath("/programs"); revalidatePath("/invoices/new");
  return { error: null, success: "Paket berhasil ditambahkan ke katalog." };
}

export async function updatePackageAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["membership.manage"]) return databaseError("Paket", "izin membership.manage diperlukan");
  const packageId = idValue(formData, "packageId"); if (!packageId) return databaseError("Paket", "paket tidak valid");
  const payload = packagePayload(formData);
  if ("invalid" in payload) return databaseError("Paket", payload.invalid);
  if (payload.size_band && payload.size_band !== "cat") {
    const band = await context.supabase.from("organization_dog_size_bands").select("key").eq("organization_id", context.organizationId).eq("key", payload.size_band).maybeSingle();
    if (band.error || !band.data) return databaseError("Paket", "ukuran tidak tersedia untuk bisnis ini");
  }
  if (payload.service_id) {
    const { data: service } = await context.supabase.from("service_catalog").select("id").eq("organization_id", context.organizationId).eq("id", payload.service_id).is("deleted_at", null).maybeSingle();
    if (!service) return databaseError("Paket", "layanan tidak ditemukan");
  }
  const isActive = formData.get("isActive") === "on";
  const { error } = await context.supabase.from("packages").update({ ...payload, is_active: isActive }).eq("organization_id", context.organizationId).eq("id", packageId);
  if (error) return databaseError("Paket gagal diperbarui", error.message);
  revalidatePath("/programs"); revalidatePath("/invoices/new");
  return { error: null, success: "Paket katalog diperbarui. Saldo yang sudah terjual tidak berubah; syarat baru berlaku untuk penjualan dan perpanjangan berikutnya." };
}

export async function setCustomerPackageStatusAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const customerPackageId = idValue(formData, "customerPackageId"); const status = textValue(formData, "status", 20);
  if (!customerPackageId || !["active", "canceled"].includes(status)) return databaseError("Paket", "data tidak valid");
  const result = await context.supabase.schema("app").rpc("set_customer_package_status", { p_customer_package: customerPackageId, p_status: status, p_reason: textValue(formData, "reason", 300) || null });
  if (result.error) return databaseError("Perubahan status gagal", /package_has_active_reservations/i.test(result.error.message) ? "paket masih memiliki sesi yang dipesan; lepaskan dulu sebelum diarsipkan" : /insufficient_privilege|42501/i.test(result.error.message) ? "izin membership.manage diperlukan" : result.error.message);
  revalidatePath("/programs"); revalidatePath("/programs/memberships");
  return { error: null, success: status === "canceled" ? "Paket berhasil diarsipkan." : "Paket berhasil diaktifkan kembali." };
}

export interface PackageReconciliationReport {
  customerPackageId: string; revision: number; status: string; cachedBalance: number; ledgerBalance: number;
  balanceMatches: boolean; autoRepairable: boolean; reservedCount: number; consumedReservations: number; consumptionLedgerEntries: number;
  reservationConsumptionMatches: boolean; manualReviewIssues: string[]; checkedAt: string;
}
export interface PackageReconciliationResult { error: string | null; report: PackageReconciliationReport | null }

/** Section 26, read-only: shows the exact mismatch (if any) before anyone touches the repair action. */
export async function previewPackageReconciliationAction(customerPackageId: string): Promise<PackageReconciliationResult> {
  const context = await workspace(); if (!context) return { error: "workspace aktif tidak tersedia", report: null };
  if (!UUID.test(customerPackageId)) return { error: "paket tidak valid", report: null };
  const result = await context.supabase.schema("app").rpc("reconcile_customer_package", { p_customer_package: customerPackageId });
  if (result.error) return { error: result.error.message, report: null };
  const data = result.data as Record<string, unknown>;
  return {
    error: null,
    report: {
      customerPackageId: String(data.customer_package_id), revision: Number(data.revision), status: String(data.status),
      cachedBalance: Number(data.cached_balance), ledgerBalance: Number(data.ledger_balance), balanceMatches: Boolean(data.balance_matches),
      autoRepairable: Boolean(data.auto_repairable),
      reservedCount: Number(data.reserved_count), consumedReservations: Number(data.consumed_reservations), consumptionLedgerEntries: Number(data.consumption_ledger_entries),
      reservationConsumptionMatches: Boolean(data.reservation_consumption_matches),
      manualReviewIssues: Array.isArray(data.manual_review_issues) ? (data.manual_review_issues as unknown[]).map(String) : [],
      checkedAt: String(data.checked_at),
    },
  };
}

export interface MembershipHistoryEntry {
  id: string; delta: number; reason: string; notes: string | null; occurredAt: string;
  invoiceNumber: string | null; invoiceId: string | null;
}
export interface MembershipReservationEntry {
  id: string; status: string; reservedAt: string; consumedAt: string | null; releasedAt: string | null; expiresAt: string | null;
}
export interface MembershipHistoryResult { error: string | null; ledger: MembershipHistoryEntry[]; reservations: MembershipReservationEntry[] }

/**
 * Section 25 detail view: purchases/renewals/consumption/adjustments (with
 * their invoice, when linked) plus the reservation lifecycle for one
 * membership. Read-only, capability-gated (membership.read), and scoped to a
 * single customer_package_id -- never an unbounded organization-wide scan.
 */
export async function loadMembershipHistoryAction(customerPackageId: string): Promise<MembershipHistoryResult> {
  const context = await workspace(); if (!context) return { error: "workspace aktif tidak tersedia", ledger: [], reservations: [] };
  if (!UUID.test(customerPackageId)) return { error: "paket tidak valid", ledger: [], reservations: [] };
  if (!(await loadCapabilities(context.supabase))["membership.read"]) return { error: "izin membership.read diperlukan", ledger: [], reservations: [] };
  const [ledgerResult, reservationResult] = await Promise.all([
    context.supabase.from("customer_package_ledger").select("id,delta,reason,notes,occurred_at,invoice_id,invoices(invoice_number)").eq("organization_id", context.organizationId).eq("customer_package_id", customerPackageId).order("occurred_at", { ascending: false }),
    context.supabase.from("package_reservations").select("id,status,reserved_at,consumed_at,released_at,expires_at").eq("organization_id", context.organizationId).eq("customer_package_id", customerPackageId).order("reserved_at", { ascending: false }),
  ]);
  if (ledgerResult.error) return { error: ledgerResult.error.message, ledger: [], reservations: [] };
  if (reservationResult.error) return { error: reservationResult.error.message, ledger: [], reservations: [] };
  return {
    error: null,
    ledger: (ledgerResult.data ?? []).map((row) => {
      const invoice = Array.isArray(row.invoices) ? row.invoices[0] : row.invoices;
      return { id: row.id, delta: row.delta, reason: row.reason, notes: row.notes, occurredAt: row.occurred_at, invoiceId: row.invoice_id, invoiceNumber: (invoice as { invoice_number?: string } | null)?.invoice_number ?? null };
    }),
    reservations: (reservationResult.data ?? []).map((row) => ({ id: row.id, status: row.status, reservedAt: row.reserved_at, consumedAt: row.consumed_at, releasedAt: row.released_at, expiresAt: row.expires_at })),
  };
}

/**
 * Section 26, guarded write: distinct from the preview above, this requires
 * membership.manage (not just membership.read) and the revision the staff
 * member last saw a preview for -- a concurrent change makes this stale and
 * it is rejected rather than silently overwriting newer data.
 */
export async function repairCustomerPackageBalanceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const customerPackageId = idValue(formData, "customerPackageId"); const requestKey = idValue(formData, "requestKey");
  const revision = numberValue(formData, "revision");
  if (!customerPackageId || !requestKey || revision === null) return databaseError("Rekonsiliasi", "data tidak valid");
  const result = await context.supabase.schema("app").rpc("repair_customer_package_balance", { p_customer_package: customerPackageId, p_revision: revision, p_request_key: requestKey });
  if (result.error) return databaseError("Perbaikan gagal", /stale_repair_request|40001/i.test(result.error.message) ? "data berubah sejak pratinjau terakhir; muat ulang dan coba lagi" : /insufficient_privilege|42501/i.test(result.error.message) ? "izin membership.manage diperlukan" : result.error.message);
  revalidatePath("/programs"); revalidatePath("/programs/memberships");
  return { error: null, success: "Saldo paket berhasil diperbaiki." };
}

// Payroll lifecycle (sections 32-33) moved to @/app/payroll/payroll-actions --
// it now goes through server-side RPCs (app.recompute_payroll_run and friends)
// instead of the client delete+insert+direct-update pattern that used to live
// here, which was not atomic and had no approval/revision guard against a
// concurrent double-submit.
