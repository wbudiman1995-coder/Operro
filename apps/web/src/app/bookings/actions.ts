"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { loadAuthContext } from "@/lib/auth-context";
import { parseBookingDraft } from "@/lib/booking-validation";
import { createClient } from "@/lib/supabase/server";

export interface CreateBookingState { error: string | null }

async function cancelDraft(supabase: Awaited<ReturnType<typeof createClient>>, bookingId: string) {
  await supabase.schema("app").rpc("transition_booking_status", { p_booking: bookingId, p_to: "canceled" });
}

export async function createBookingAction(
  _previous: CreateBookingState,
  formData: FormData,
): Promise<CreateBookingState> {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context?.activeOrganization) return { error: "Sesi atau workspace aktif tidak valid. Silakan masuk kembali." };

  let draft;
  try {
    draft = parseBookingDraft(JSON.parse(String(formData.get("booking") ?? "null")));
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Data booking tidak valid." };
  }

  const organizationId = context.activeOrganization.id;
  const app = supabase.schema("app");
  const [{ data: branch }, { data: customer }, { data: pets }, { data: services }, { data: resources }] = await Promise.all([
    supabase.from("branches").select("id").eq("organization_id", organizationId).eq("id", draft.branchId).eq("status", "active").is("deleted_at", null).maybeSingle(),
    supabase.from("customers").select("id").eq("organization_id", organizationId).eq("id", draft.customerId).is("deleted_at", null).maybeSingle(),
    supabase.from("pets").select("id,customer_id").eq("organization_id", organizationId).in("id", draft.pets.map((pet) => pet.petId)).is("deleted_at", null),
    supabase.from("service_catalog").select("id,category").eq("organization_id", organizationId).in("id", draft.pets.flatMap((pet) => pet.serviceIds)).eq("is_active", true).is("deleted_at", null),
    supabase.from("resources").select("id,branch_id").eq("organization_id", organizationId).in("id", draft.pets.map((pet) => pet.resourceId)).eq("status", "active").is("deleted_at", null),
  ]);
  const requestedServiceIds = new Set(draft.pets.flatMap((pet) => pet.serviceIds));
  if (!branch || !customer || pets?.length !== draft.pets.length || pets.some((pet) => pet.customer_id !== draft.customerId) || services?.length !== requestedServiceIds.size || resources?.some((resource) => resource.branch_id !== draft.branchId) || new Set(resources?.map((resource) => resource.id)).size !== new Set(draft.pets.map((pet) => pet.resourceId)).size) {
    return { error: "Pilihan booking berubah atau tidak dapat diakses. Muat ulang halaman lalu coba lagi." };
  }
  const serviceCategoryById = new Map((services ?? []).map((service) => [service.id, service.category?.trim() || "Lainnya"]));
  const requestedCategories = new Set(serviceCategoryById.values());
  if (draft.categoryDiscounts.some((discount) => !requestedCategories.has(discount.category))) {
    return { error: "Kategori diskon tidak cocok dengan layanan yang dipilih." };
  }

  const selectedPackageIds = [...new Set(draft.pets.flatMap((pet) => Object.values(pet.packageByService)))];
  const packageRows = selectedPackageIds.length > 0
    ? await supabase.from("customer_packages").select("id,customer_id,service_id,sessions_remaining,status,expires_at").eq("organization_id", organizationId).in("id", selectedPackageIds).is("deleted_at", null)
    : { data: [], error: null };
  if (packageRows.error || packageRows.data?.length !== selectedPackageIds.length) return { error: "Paket pelanggan berubah atau tidak dapat diakses." };
  const packageById = new Map((packageRows.data ?? []).map((item) => [item.id, item]));
  const packageUsage = new Map<string, number>();
  for (const pet of draft.pets) for (const [serviceId, packageId] of Object.entries(pet.packageByService)) {
    const item = packageById.get(packageId);
    packageUsage.set(packageId, (packageUsage.get(packageId) ?? 0) + 1);
    if (!item || item.customer_id !== draft.customerId || item.status !== "active" || (item.expires_at && new Date(item.expires_at) <= new Date()) || (item.service_id && item.service_id !== serviceId)) {
      return { error: "Paket yang dipilih tidak aktif atau tidak berlaku untuk layanan ini." };
    }
  }
  if ([...packageUsage].some(([id, count]) => Number(packageById.get(id)?.sessions_remaining ?? 0) < count)) {
    return { error: "Sesi paket tidak cukup untuk semua layanan yang dialokasikan." };
  }

  // Home-service bookings carry an immutable location snapshot: the full address, contact
  // and access notes as they are right now, plus the service-area/travel-fee decision made
  // at booking time. Neither is re-derived later, so editing or deleting the saved address
  // afterward cannot change a booking that already exists (Deliverable B).
  let addressSnapshot: Record<string, unknown> | null = null;
  let travelFee: number | null = null;
  let travelMinutesSnapshot: number | null = null;
  let serviceAreaMatched: boolean | null = null;
  if (draft.fulfillmentMode === "home") {
    if (!draft.customerAddressId) return { error: "Pilih alamat pelanggan untuk booking home service." };
    const { data: address } = await supabase
      .from("customer_addresses")
      .select("id,label,recipient_name,recipient_phone,line1,line2,rt,rw,kelurahan,kecamatan,kabupaten_kota,province,postal_code,landmark,access_notes,latitude,longitude")
      .eq("organization_id", organizationId)
      .eq("customer_id", draft.customerId)
      .eq("id", draft.customerAddressId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!address) return { error: "Alamat pelanggan tidak ditemukan atau bukan milik pelanggan ini." };

    const { data: coverage, error: coverageError } = await app.rpc("fn_check_service_area", {
      p_branch: draft.branchId,
      p_kecamatan: address.kecamatan,
      p_kabupaten_kota: address.kabupaten_kota,
    });
    if (coverageError) return { error: `Pemeriksaan area layanan gagal: ${coverageError.message}` };
    const zone = Array.isArray(coverage) ? coverage[0] : coverage;
    if (!zone?.allowed) {
      return { error: `Lokasi ini (${address.kecamatan ?? address.kabupaten_kota ?? "area tidak diketahui"}) belum tercakup oleh cabang ini. Pilih cabang lain atau perbarui area layanan.` };
    }

    addressSnapshot = address;
    travelFee = Number(zone.travel_fee ?? 0);
    travelMinutesSnapshot = Number(zone.estimated_travel_minutes ?? 0);
    serviceAreaMatched = true;
  }

  const { data: booking, error: bookingError } = await supabase.from("bookings").insert({
    organization_id: organizationId,
    branch_id: draft.branchId,
    customer_id: draft.customerId,
    booking_type: "grooming",
    fulfillment_mode: draft.fulfillmentMode,
    starts_at: draft.startsAt,
    ends_at: draft.endsAt,
    notes: draft.customerNotes || null,
    metadata: {
      ...(draft.internalNotes ? { internal_notes: draft.internalNotes } : {}),
      category_discounts: {
        rules: draft.categoryDiscounts,
        service_categories: Object.fromEntries(serviceCategoryById),
      },
    },
    customer_address_id: draft.fulfillmentMode === "home" ? draft.customerAddressId : null,
    address_snapshot: addressSnapshot,
    travel_fee: travelFee,
    travel_minutes_snapshot: travelMinutesSnapshot,
    service_area_matched: serviceAreaMatched,
    dispatch_stage: draft.fulfillmentMode === "home" ? "scheduled" : null,
  }).select("id").single();
  if (bookingError || !booking) return { error: `Booking tidak dapat dibuat: ${bookingError?.message ?? "unknown"}` };

  try {
    const { error: jobError } = await supabase.from("grooming_jobs").insert({ booking_id: booking.id, organization_id: organizationId, groomer_notes: draft.groomerNotes || null });
    if (jobError) throw jobError;

    const uniqueResources = [...new Set(draft.pets.map((pet) => pet.resourceId))];
    const { error: holdError } = await supabase.from("booking_resources").insert(uniqueResources.map((resourceId) => ({
      booking_id: booking.id,
      resource_id: resourceId,
      organization_id: organizationId,
      during: `[${draft.startsAt},${draft.endsAt})`,
    })));
    if (holdError) throw holdError;

    for (const pet of draft.pets) {
      const { data: jobPetId, error: petError } = await app.rpc("assembly_add_pet", { p_booking: booking.id, p_pet: pet.petId, p_is_required: true });
      if (petError || !jobPetId) throw petError ?? new Error("pet_assembly_failed");
      const { error: resourceError } = await app.rpc("assembly_assign_pet_resource", { p_pet: jobPetId, p_resource: pet.resourceId });
      if (resourceError) throw resourceError;
      for (const serviceId of pet.serviceIds) {
        const { data: lineId, error: lineError } = await app.rpc("assembly_add_line", { p_pet: jobPetId, p_service: serviceId, p_quantity: 1 });
        if (lineError || !lineId) throw lineError ?? new Error("service_line_missing");
        const packageId = pet.packageByService[serviceId];
        if (packageId) {
          const { error: packageError } = await app.rpc("reserve_package_session", { p_line: lineId, p_customer_package: packageId, p_expires_at: null });
          if (packageError) throw packageError;
        }
      }
    }
    const { error: confirmError } = await app.rpc("transition_booking_status", { p_booking: booking.id, p_to: "confirmed" });
    if (confirmError) throw confirmError;
    // The RPC locks the customer's active one-use offer, calculates immutable
    // per-service discounts, snapshots them onto this booking, and consumes the
    // offer in one transaction. A null result simply means no offer is active.
    const { error: discountError } = await app.rpc("consume_customer_next_discount", { p_booking: booking.id });
    if (discountError) throw discountError;
  } catch (error) {
    await cancelDraft(supabase, booking.id);
    const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? "unknown");
    const conflict = /overlap|ex_booking_resources|23P01/i.test(message);
    return { error: conflict ? "Groomer sudah memiliki booking pada waktu tersebut. Pilih waktu atau groomer lain." : `Booking belum lengkap dan draft dibatalkan otomatis: ${message}` };
  }

  revalidatePath("/bookings");
  redirect(`/bookings?created=${booking.id}`);
}
