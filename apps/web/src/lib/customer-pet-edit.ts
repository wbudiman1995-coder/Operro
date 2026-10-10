export const PET_NAME_MAX = 80;
export const PET_BREED_MAX = 100;
export const PET_COLOR_MAX = 80;
export const PET_TEMPERAMENT_MAX = 120;
export const PET_NOTES_MAX = 1000;
export const PET_SKIN_HISTORY_MAX = 1000;

/** Coat options from the HomePaw dog form. Colour is the existing `color` field. */
export const PET_COAT_TYPES = ["short", "long", "curly", "double_coat"] as const;
export type PetCoatType = (typeof PET_COAT_TYPES)[number];
export const PET_COAT_LABELS: Record<PetCoatType, string> = { short: "Pendek", long: "Panjang", curly: "Keriting", double_coat: "Double coat" };

export interface CustomerPetUpdate {
  name: string;
  species: string;
  breed: string | null;
  sex: "male" | "female" | "unknown";
  birthdate: string | null;
  weightKg: number | null;
  manualSize: string | null;
  color: string | null;
  temperament: string | null;
  notes: string | null;
  coatType: PetCoatType | null;
  skinHistory: string | null;
}

export type CustomerPetParseResult =
  | { ok: true; update: CustomerPetUpdate }
  | { ok: false; message: string };

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,29}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function readSingle(formData: FormData, key: string): string | null {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

function optionalText(raw: string, maximum: number): string | null | undefined {
  const value = raw.trim();
  if (!value) return null;
  return Array.from(value).length <= maximum ? value : undefined;
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getTime() <= Date.now();
}

export function parseCustomerPetForm(formData: FormData): CustomerPetParseResult {
  const fields = ["name", "species", "breed", "sex", "birthdate", "weightKg", "manualSize", "color", "temperament", "notes", "coatType", "skinHistory"] as const;
  const raw = Object.fromEntries(fields.map((key) => [key, readSingle(formData, key)])) as Record<(typeof fields)[number], string | null>;
  if (fields.some((key) => raw[key] === null)) return { ok: false, message: "Data hewan tidak lengkap atau dikirim berulang." };

  const name = raw.name!.trim();
  const species = raw.species!.trim();
  const sex = raw.sex!.trim();
  const birthdateText = raw.birthdate!.trim();
  const weightText = raw.weightKg!.trim();
  const sizeText = raw.manualSize!.trim();
  const breed = optionalText(raw.breed!, PET_BREED_MAX);
  const color = optionalText(raw.color!, PET_COLOR_MAX);
  const temperament = optionalText(raw.temperament!, PET_TEMPERAMENT_MAX);
  const notes = optionalText(raw.notes!, PET_NOTES_MAX);
  const coatText = raw.coatType!.trim();
  const skinHistory = optionalText(raw.skinHistory!, PET_SKIN_HISTORY_MAX);

  if (!name || Array.from(name).length > PET_NAME_MAX) return { ok: false, message: `Nama hewan wajib diisi dan maksimal ${PET_NAME_MAX} karakter.` };
  if (!KEY_PATTERN.test(species)) return { ok: false, message: "Jenis hewan tidak valid." };
  if (sex !== "male" && sex !== "female" && sex !== "unknown") return { ok: false, message: "Jenis kelamin hewan tidak valid." };
  if (birthdateText && !validDate(birthdateText)) return { ok: false, message: "Tanggal lahir hewan tidak valid." };
  if (coatText && !(PET_COAT_TYPES as readonly string[]).includes(coatText)) return { ok: false, message: "Jenis bulu tidak valid." };
  if (skinHistory === undefined) return { ok: false, message: `Riwayat kulit maksimal ${PET_SKIN_HISTORY_MAX} karakter.` };
  if (breed === undefined || color === undefined || temperament === undefined || notes === undefined) return { ok: false, message: "Salah satu kolom hewan terlalu panjang." };

  let weightKg: number | null = null;
  if (weightText) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(weightText)) return { ok: false, message: "Berat harus berupa angka dengan maksimal dua desimal." };
    weightKg = Number(weightText);
    if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 999) return { ok: false, message: "Berat harus lebih dari 0 dan maksimal 999 kg." };
  }

  if (sizeText && !KEY_PATTERN.test(sizeText)) return { ok: false, message: "Ukuran manual tidak valid." };
  if (species !== "dog" && sizeText) return { ok: false, message: "Ukuran manual hanya berlaku untuk anjing." };

  return {
    ok: true,
    update: {
      name,
      species,
      breed,
      sex,
      birthdate: birthdateText || null,
      weightKg,
      manualSize: sizeText || null,
      color,
      temperament,
      notes,
      coatType: (coatText || null) as PetCoatType | null,
      skinHistory,
    },
  };
}
