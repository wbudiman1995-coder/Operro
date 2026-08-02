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
    supabase.from("service_catalog").select("id").eq("organization_id", organizationId).in("id", draft.pets.flatMap((pet) => pet.serviceIds)).eq("is_active", true).is("deleted_at", null),
    supabase.from("resources").select("id,branch_id").eq("organization_id", organizationId).in("id", draft.pets.map((pet) => pet.resourceId)).eq("status", "active").is("deleted_at", null),
  ]);
  const requestedServiceIds = new Set(draft.pets.flatMap((pet) => pet.serviceIds));
  if (!branch || !customer || pets?.length !== draft.pets.length || pets.some((pet) => pet.customer_id !== draft.customerId) || services?.length !== requestedServiceIds.size || resources?.some((resource) => resource.branch_id !== draft.branchId) || new Set(resources?.map((resource) => resource.id)).size !== new Set(draft.pets.map((pet) => pet.resourceId)).size) {
    return { error: "Pilihan booking berubah atau tidak dapat diakses. Muat ulang halaman lalu coba lagi." };
  }

  const { data: booking, error: bookingError } = await supabase.from("bookings").insert({
    organization_id: organizationId,
    branch_id: draft.branchId,
    customer_id: draft.customerId,
    booking_type: "grooming",
    fulfillment_mode: draft.fulfillmentMode,
    starts_at: draft.startsAt,
    ends_at: draft.endsAt,
    notes: draft.notes || null,
  }).select("id").single();
  if (bookingError || !booking) return { error: `Booking tidak dapat dibuat: ${bookingError?.message ?? "unknown"}` };

  try {
    const { error: jobError } = await supabase.from("grooming_jobs").insert({ booking_id: booking.id, organization_id: organizationId });
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
        const { error: lineError } = await app.rpc("assembly_add_line", { p_pet: jobPetId, p_service: serviceId, p_quantity: 1 });
        if (lineError) throw lineError;
      }
    }
    const { error: confirmError } = await app.rpc("transition_booking_status", { p_booking: booking.id, p_to: "confirmed" });
    if (confirmError) throw confirmError;
  } catch (error) {
    await cancelDraft(supabase, booking.id);
    const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? "unknown");
    const conflict = /overlap|ex_booking_resources|23P01/i.test(message);
    return { error: conflict ? "Groomer sudah memiliki booking pada waktu tersebut. Pilih waktu atau groomer lain." : `Booking belum lengkap dan draft dibatalkan otomatis: ${message}` };
  }

  revalidatePath("/bookings");
  redirect(`/bookings?created=${booking.id}`);
}
