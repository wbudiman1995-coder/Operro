/** Pure validation shared by the booking server action and contract tests. */
export type FulfillmentMode = "in_store" | "home" | "pickup_delivery";

export interface BookingPetDraft {
  petId: string;
  resourceId: string;
  serviceIds: string[];
}

export interface BookingDraft {
  branchId: string;
  customerId: string;
  startsAt: string;
  endsAt: string;
  fulfillmentMode: FulfillmentMode;
  notes: string;
  pets: BookingPetDraft[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set<FulfillmentMode>(["in_store", "home", "pickup_delivery"]);

export function parseBookingDraft(raw: unknown): BookingDraft {
  if (!raw || typeof raw !== "object") throw new Error("Data booking tidak valid.");
  const value = raw as Record<string, unknown>;
  const pets = Array.isArray(value.pets) ? value.pets : [];

  if (![value.branchId, value.customerId].every((id) => typeof id === "string" && UUID.test(id))) {
    throw new Error("Cabang atau pelanggan tidak valid.");
  }
  if (typeof value.fulfillmentMode !== "string" || !MODES.has(value.fulfillmentMode as FulfillmentMode)) {
    throw new Error("Metode layanan tidak valid.");
  }
  if (typeof value.startsAt !== "string" || typeof value.endsAt !== "string") {
    throw new Error("Tanggal dan waktu wajib diisi.");
  }
  const startsAt = new Date(value.startsAt);
  const endsAt = new Date(value.endsAt);
  if (!Number.isFinite(startsAt.valueOf()) || !Number.isFinite(endsAt.valueOf()) || endsAt <= startsAt) {
    throw new Error("Waktu selesai harus setelah waktu mulai.");
  }
  if (pets.length === 0) throw new Error("Pilih minimal satu hewan.");

  const normalizedPets = pets.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Data hewan tidak valid.");
    const pet = entry as Record<string, unknown>;
    if (typeof pet.petId !== "string" || !UUID.test(pet.petId)) throw new Error("Hewan tidak valid.");
    if (typeof pet.resourceId !== "string" || !UUID.test(pet.resourceId)) throw new Error("Pilih groomer untuk setiap hewan.");
    if (!Array.isArray(pet.serviceIds) || pet.serviceIds.length === 0 || pet.serviceIds.some((id) => typeof id !== "string" || !UUID.test(id))) {
      throw new Error("Pilih minimal satu layanan untuk setiap hewan.");
    }
    return { petId: pet.petId, resourceId: pet.resourceId, serviceIds: [...new Set(pet.serviceIds as string[])] };
  });

  if (new Set(normalizedPets.map((pet) => pet.petId)).size !== normalizedPets.length) {
    throw new Error("Hewan yang sama tidak boleh dipilih dua kali.");
  }

  return {
    branchId: value.branchId as string,
    customerId: value.customerId as string,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    fulfillmentMode: value.fulfillmentMode as FulfillmentMode,
    notes: typeof value.notes === "string" ? value.notes.trim().slice(0, 1000) : "",
    pets: normalizedPets,
  };
}
