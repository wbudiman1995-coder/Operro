/** Pure validation shared by the booking server action and contract tests. */
export type FulfillmentMode = "in_store" | "home" | "pickup_delivery";

export interface BookingPetDraft {
  petId: string;
  resourceId: string;
  serviceIds: string[];
  packageByService: Record<string, string>;
}

export interface BookingCategoryDiscount {
  category: string;
  type: "percent" | "fixed";
  value: number;
}

export interface BookingDraft {
  branchId: string;
  customerId: string;
  startsAt: string;
  endsAt: string;
  fulfillmentMode: FulfillmentMode;
  customerNotes: string;
  groomerNotes: string;
  internalNotes: string;
  categoryDiscounts: BookingCategoryDiscount[];
  pets: BookingPetDraft[];
  /**
   * Structurally optional here — a UUID if present, nothing enforced about *when* it must
   * be present. "Required for fulfillmentMode 'home'" is a business rule, not a shape rule,
   * and is checked in the server action (createBookingAction) where the DB lookup that
   * proves the address actually exists and belongs to this customer already has to happen.
   * Keeping that rule out of this pure function is also what keeps the existing
   * booking-validation.test.ts fixtures (all fulfillmentMode: "home", none with an address)
   * passing unchanged.
   */
  customerAddressId?: string;
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
    const serviceIds = [...new Set(pet.serviceIds as string[])];
    const rawPackages = pet.packageByService && typeof pet.packageByService === "object" && !Array.isArray(pet.packageByService)
      ? pet.packageByService as Record<string, unknown>
      : {};
    const packageByService = Object.fromEntries(Object.entries(rawPackages).flatMap(([serviceId, packageId]) => {
      if (!serviceIds.includes(serviceId) || typeof packageId !== "string" || !UUID.test(packageId)) throw new Error("Alokasi paket tidak valid.");
      return [[serviceId, packageId]];
    }));
    return { petId: pet.petId, resourceId: pet.resourceId, serviceIds, packageByService };
  });

  if (new Set(normalizedPets.map((pet) => pet.petId)).size !== normalizedPets.length) {
    throw new Error("Hewan yang sama tidak boleh dipilih dua kali.");
  }

  if (value.customerAddressId !== undefined && (typeof value.customerAddressId !== "string" || !UUID.test(value.customerAddressId))) {
    throw new Error("Alamat pelanggan tidak valid.");
  }

  const categoryDiscounts = (Array.isArray(value.categoryDiscounts) ? value.categoryDiscounts : []).map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Diskon kategori tidak valid.");
    const discount = entry as Record<string, unknown>;
    const category = typeof discount.category === "string" ? discount.category.trim().slice(0, 80) : "";
    const type = discount.type;
    const amount = Number(discount.value);
    if (!category || (type !== "percent" && type !== "fixed") || !Number.isFinite(amount) || amount <= 0 || (type === "percent" && amount > 100) || (type === "fixed" && amount > 1_000_000_000)) {
      throw new Error("Diskon kategori tidak valid.");
    }
    return { category, type, value: amount } as BookingCategoryDiscount;
  });
  if (categoryDiscounts.length > 20 || new Set(categoryDiscounts.map((item) => item.category.toLowerCase())).size !== categoryDiscounts.length) {
    throw new Error("Setiap kategori hanya boleh memiliki satu diskon.");
  }

  return {
    branchId: value.branchId as string,
    customerId: value.customerId as string,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    fulfillmentMode: value.fulfillmentMode as FulfillmentMode,
    customerNotes: typeof value.customerNotes === "string" ? value.customerNotes.trim().slice(0, 1000) : typeof value.notes === "string" ? value.notes.trim().slice(0, 1000) : "",
    groomerNotes: typeof value.groomerNotes === "string" ? value.groomerNotes.trim().slice(0, 1000) : "",
    internalNotes: typeof value.internalNotes === "string" ? value.internalNotes.trim().slice(0, 1000) : "",
    categoryDiscounts,
    pets: normalizedPets,
    ...(typeof value.customerAddressId === "string" ? { customerAddressId: value.customerAddressId } : {}),
  };
}
