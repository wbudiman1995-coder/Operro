/** HomePaw starter bands. Persisted pet sizes remain editable when weight is unknown. */
export const DOG_SIZE_BANDS = [
  { value: "extra_small", label: "XS", weight: "< 5 kg" },
  { value: "small", label: "S", weight: "5–<10 kg" },
  { value: "medium", label: "M", weight: "10–<15 kg" },
  { value: "large", label: "L", weight: "15–25 kg" },
  { value: "extra_large", label: "XL", weight: "> 25 kg" },
] as const;

export type DogSize = (typeof DOG_SIZE_BANDS)[number]["value"];
export type PricingBand = DogSize | "cat" | (string & {});
export type SpeciesPricing = Record<string, { price: number; duration: number }>;
export type DogSizeBoundaries = { xs: number; s: number; m: number; l: number };
export const DEFAULT_DOG_SIZE_BOUNDARIES: DogSizeBoundaries = { xs: 5, s: 10, m: 15, l: 25 };

export function dogSizeFromWeight(weight: number | string | null | undefined): DogSize | null;
export function dogSizeFromWeight(weight: number | string | null | undefined, boundaries: DogSizeBoundaries): DogSize | null;
export function dogSizeFromWeight(weight: number | string | null | undefined, boundaries: DogSizeBoundaries | number = DEFAULT_DOG_SIZE_BOUNDARIES): DogSize | null {
  if (weight === null || weight === undefined || weight === "") return null;
  const kg = Number(weight);
  if (!Number.isFinite(kg) || kg <= 0) return null;
  // Array.map passes its index as the second callback argument.
  const limits = typeof boundaries === "object" ? boundaries : DEFAULT_DOG_SIZE_BOUNDARIES;
  if (kg < limits.xs) return "extra_small";
  if (kg < limits.s) return "small";
  if (kg < limits.m) return "medium";
  if (kg <= limits.l) return "large";
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
  speciesPricing?: SpeciesPricing;
}

const priceKey = { extra_small: "priceExtraSmall", small: "priceSmall", medium: "priceMedium", large: "priceLarge", extra_large: "priceExtraLarge", cat: "priceCat" } as const;
const durationKey = { extra_small: "durationExtraSmall", small: "durationSmall", medium: "durationMedium", large: "durationLarge", extra_large: "durationExtraLarge", cat: "durationCat" } as const;

export function pricingBand(pet: SizedPet): PricingBand | null {
  if (pet.species === "cat") return "cat";
  if (pet.species !== "dog") return pet.species || null;
  // pets.size is assigned by the database trigger using this organization's
  // editable boundaries. Weight-only fallback is for legacy unsized rows.
  return DOG_SIZE_BANDS.some((band) => band.value === pet.size) ? pet.size as DogSize : dogSizeFromWeight(pet.weightKg);
}

export function resolveServiceForPet(service: SizedService, pet: SizedPet): { price: number; duration: number; band: PricingBand | null } {
  const band = pricingBand(pet);
  if (pet.species !== "dog" && pet.species !== "cat") {
    const custom = service.speciesPricing?.[pet.species];
    return { band, price: custom?.price ?? service.basePrice, duration: custom?.duration ?? 0 };
  }
  return {
    band,
    price: band && band in priceKey ? service[priceKey[band as keyof typeof priceKey]] ?? service.basePrice : service.basePrice,
    duration: band && band in durationKey ? service[durationKey[band as keyof typeof durationKey]] ?? service.durationMinutes : service.durationMinutes,
  };
}
