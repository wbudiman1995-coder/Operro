"use client";

/** A short, practical intake list with a free-text escape for mixed and uncommon breeds. */
const BREEDS = {
  dog: ["Campuran / Mix", "Beagle", "Border Collie", "Bulldog", "Chihuahua", "Corgi", "Dachshund", "French Bulldog", "Golden Retriever", "Husky", "Labrador Retriever", "Maltese", "Pomeranian", "Poodle", "Samoyed", "Shiba Inu", "Shih Tzu", "Schnauzer", "Yorkshire Terrier"],
  cat: ["Campuran / Domestik", "Abyssinian", "American Shorthair", "Anggora", "Bengal", "British Shorthair", "Exotic Shorthair", "Himalayan", "Maine Coon", "Munchkin", "Persian", "Ragdoll", "Scottish Fold", "Siamese", "Sphynx"],
} as const;

export function BreedSelect({ species, value, onChange, className, label = "Ras pet" }: {
  species: "dog" | "cat"; value: string; onChange: (value: string) => void; className: string; label?: string;
}) {
  const options: readonly string[] = BREEDS[species];
  const known = !value || options.includes(value);
  return <div className="min-w-0 space-y-1">
    <select className={className} value={known ? value : "__other__"} onChange={(event) => onChange(event.target.value === "__other__" ? "Lainnya" : event.target.value)} aria-label={label}>
      <option value="">Pilih ras (opsional)</option>
      {options.map((breed) => <option key={breed} value={breed}>{breed}</option>)}
      <option value="__other__">Ras lain / tulis sendiri</option>
    </select>
    {!known ? <input className={className} value={value === "Lainnya" ? "" : value} onChange={(event) => onChange(event.target.value)} placeholder="Tulis ras atau campuran" aria-label={`${label} lainnya`} maxLength={100} /> : null}
  </div>;
}
