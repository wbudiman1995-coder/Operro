/** HomePaw starter bands. Persisted pet sizes remain editable when weight is unknown. */
export const DOG_SIZE_BANDS = [
  { value: "extra_small", label: "XS", weight: "< 5 kg" },
  { value: "small", label: "S", weight: "5–<10 kg" },
  { value: "medium", label: "M", weight: "10–<15 kg" },
  { value: "large", label: "L", weight: "15–25 kg" },
  { value: "extra_large", label: "XL", weight: "> 25 kg" },
] as const;

export type DogSize = (typeof DOG_SIZE_BANDS)[number]["value"];
export type PricingBand = DogSize | "cat";

export function dogSizeFromWeight(weight: number | string | null | undefined): DogSize | null {
  if (weight === null || weight === undefined || weight === "") return null;
  const kg = Number(weight);
  if (!Number.isFinite(kg) || kg <= 0) return null;
  if (kg < 5) return "extra_small";
  if (kg < 10) return "small";
  if (kg < 15) return "medium";
  if (kg <= 25) return "large";
  return "extra_large";
}

export interface SizedPet { species: string; size: string | null; weightKg?: number | string | null }
export interface SizedService {
  durationMinutes: number;
  basePrice: number;
  priceExtraSmall?: number | null; priceSmall?: number | null; priceMedium?: number | null;
  priceLarge?: number | null; priceExtraLarge?: number | null; priceCat?: number | null;
  durationExtraSmall?: number | null; durationSmall?: number | null; durationMedium?: number | null;
  durationLarge?: number | null; durationExtraLarge?: number | null; durationCat?: number | null;
}

const priceKey = { extra_small: "priceExtraSmall", small: "priceSmall", medium: "priceMedium", large: "priceLarge", extra_large: "priceExtraLarge", cat: "priceCat" } as const;
const durationKey = { extra_small: "durationExtraSmall", small: "durationSmall", medium: "durationMedium", large: "durationLarge", extra_large: "durationExtraLarge", cat: "durationCat" } as const;

export function pricingBand(pet: SizedPet): PricingBand | null {
  if (pet.species === "cat") return "cat";
  if (pet.species !== "dog") return null;
  return dogSizeFromWeight(pet.weightKg) ?? (DOG_SIZE_BANDS.some((band) => band.value === pet.size) ? pet.size as DogSize : null);
}

export function resolveServiceForPet(service: SizedService, pet: SizedPet): { price: number; duration: number; band: PricingBand | null } {
  const band = pricingBand(pet);
  return {
    band,
    price: band ? service[priceKey[band]] ?? service.basePrice : service.basePrice,
    duration: band ? service[durationKey[band]] ?? service.durationMinutes : service.durationMinutes,
  };
}
