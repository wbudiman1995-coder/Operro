import { parseMapCoordinates } from "@/lib/maps";

export interface ParsedChatPet {
  name: string;
  species: "dog" | "cat";
  breed: string;
  age: string;
  weightKg: number | null;
  color: string;
  notes: string;
}

export interface ParsedBookingChat {
  customerName: string;
  phone: string;
  addressLine: string;
  kabupatenKota: string;
  kecamatan: string;
  mapsInput: string;
  latitude: number | null;
  longitude: number | null;
  pets: ParsedChatPet[];
}

function normalizeLabel(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
}

function field(lines: string[], labels: string[]) {
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = normalizeLabel(line.slice(0, separator));
    if (labels.some((label) => key.includes(normalizeLabel(label)))) return line.slice(separator + 1).trim();
  }
  return "";
}

function splitPets(value: string) {
  return value.split(/\s+dan\s+|\s*&\s*|\s*,\s*/i).map((item) => item.trim()).filter(Boolean);
}

function distribute(value: string, count: number) {
  if (!value) return Array<string>(count).fill("");
  // A comma between digits is a decimal separator in Indonesian input ("4,5 kg"),
  // not a separator between pets.
  const parts = value.split(/\s+dan\s+|\s*&\s*|,\s*(?=[^0-9])/i).map((item) => item.trim()).filter(Boolean);
  return parts.length === count ? parts : Array<string>(count).fill(value.trim());
}

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("62")) return `+${digits}`;
  if (digits.startsWith("0")) return `+62${digits.slice(1)}`;
  return digits ? `+${digits}` : "";
}

export function parseBookingChat(raw: string): ParsedBookingChat {
  const lines = raw.replace(/\r/g, "").split("\n");
  const mapsInput = field(lines, ["gmaps link", "gmaps", "google maps", "shareloc", "share loc", "lokasi"]);
  const coordinates = parseMapCoordinates(mapsInput);
  const names = splitPets(field(lines, ["nama anabul", "nama anak bulu", "nama anabull", "nama pet", "pet"]));
  const breeds = distribute(field(lines, ["breed", "ras"]), names.length);
  const ages = distribute(field(lines, ["umur", "usia"]), names.length);
  const weights = distribute(field(lines, ["berat", "weight"]), names.length);
  const colors = distribute(field(lines, ["warna bulu", "warna", "color"]), names.length);
  const notes = distribute(field(lines, ["special note", "catatan", "note untuk groomer", "groomer note"]), names.length);

  return {
    customerName: field(lines, ["nama owner", "nama customer", "owner", "customer"]),
    phone: normalizePhone(field(lines, ["whatsapp", "nomor wa", "no wa", "phone", "telepon"])),
    addressLine: field(lines, ["alamat lengkap", "alamat"]),
    kabupatenKota: field(lines, ["kabupaten/kota", "kabupaten", "kota"]),
    kecamatan: field(lines, ["kecamatan"]),
    mapsInput,
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    pets: names.slice(0, 10).map((name, index) => ({
      name,
      species: /kucing|cat/i.test(`${breeds[index]} ${notes[index]}`) ? "cat" : "dog",
      breed: breeds[index],
      age: ages[index],
      weightKg: Number.isFinite(Number(weights[index].replace(",", ".").replace(/[^0-9.]/g, ""))) && weights[index].trim() ? Number(weights[index].replace(",", ".").replace(/[^0-9.]/g, "")) : null,
      color: colors[index],
      notes: notes[index],
    })),
  };
}
