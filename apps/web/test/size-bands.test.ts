import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  BAND_DURATION_PREFIX, BAND_PRICE_PREFIX, LAYOUT_ISSUE_TEXT, MAX_ACTIVE_DOG_BANDS, activeDogBands, addTopBand, archivedDogBands, bandFieldNames, copyBandValues,
  bandForWeight, describeImpact, draftFromBands, draftToPayload, mapSizeBandError, moveBand, packageSizeOptions, parseBandPriceForm, parseImpact, previewBandKey, previewDraftLabel, resolveForPricingKey,
  previousColumnKey, pricingColumns, rangeLabel, starterIndexForBand, validateLayoutDraft, type LayoutDraftRow, type SizeBand,
} from "../src/lib/size-bands";

const goldenPath = path.join(__dirname, "../../../integration/size_band_golden_vectors.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as {
  layouts: Array<{ id: string; bands: Array<{ key: string; label: string; upper_kg: number | null; upper_inclusive: boolean }> }>;
  cases: Array<{ layout: string; weight_kg: number; expected_key: string }>;
};

function band(key: string, label: string, upperKg: number | null, upperInclusive: boolean, sortOrder: number, extra: Partial<SizeBand> = {}): SizeBand {
  return { id: `id-${key}`, key, kind: "dog_weight", label, sortOrder, upperKg, upperInclusive, status: "active", ...extra };
}
const cat: SizeBand = { id: "id-cat", key: "cat", kind: "cat", label: "Cat", sortOrder: 1000, upperKg: null, upperInclusive: false, status: "active" };
const legacy: SizeBand[] = [band("extra_small", "XS", 5, false, 10), band("small", "S", 10, false, 20), band("medium", "M", 15, false, 30), band("large", "L", 25, true, 40), band("extra_large", "XL", null, false, 50), cat];
const withXxl: SizeBand[] = [
  band("extra_small", "XS", 5, false, 10), band("small", "S", 10, false, 20), band("medium", "M", 15, false, 30), band("large", "L", 25, true, 40),
  band("extra_large", "XL", 35, true, 50), band("xxl", "XXL", null, false, 60), cat,
  band("old", "Lama", 99, false, 70, { status: "archived" }),
];

test("shared golden vectors: the display preview agrees with the SQL golden file for every layout and weight", () => {
  assert.ok(golden.cases.length >= 80);
  for (const layout of golden.layouts) {
    const bands = layout.bands.map((item, index) => ({ key: item.key, upperKg: item.upper_kg, upperInclusive: item.upper_inclusive, sortOrder: index }));
    for (const item of golden.cases.filter((candidate) => candidate.layout === layout.id)) {
      assert.equal(previewBandKey(bands, item.weight_kg), item.expected_key, `${layout.id} @ ${item.weight_kg} kg`);
    }
  }
});

test("legacy edge is preserved in the preview: exactly 25.00 kg is large, 25.01 kg is extra_large", () => {
  assert.equal(previewBandKey(legacy.filter((item) => item.kind === "dog_weight"), 25), "large");
  assert.equal(previewBandKey(legacy.filter((item) => item.kind === "dog_weight"), 25.01), "extra_large");
  assert.equal(previewBandKey(legacy.filter((item) => item.kind === "dog_weight"), 0), null);
});

test("dynamic preview resolves a sixth band and server-loaded row prices without nearest-band fallback", () => {
  assert.equal(bandForWeight(withXxl.filter((item) => item.kind === "dog_weight"), 40), "xxl");
  assert.equal(bandForWeight(withXxl.filter((item) => item.kind === "dog_weight"), 35), "extra_large");
  const service = { durationMinutes: 60, basePrice: 100_000, additionalDurationMinutes: 15, bandPrices: { xxl: { price: 400_000, duration: 150 } } };
  assert.deepEqual(resolveForPricingKey(service, "dog", "xxl", 2), { band: "xxl", price: 400_000, duration: 165 });
  assert.deepEqual(resolveForPricingKey(service, "dog", "extra_large"), { band: "extra_large", price: 100_000, duration: 60 });
  assert.deepEqual(resolveForPricingKey({ ...service, durationMinutes: 0, bandPrices: { xxl: { price: 25_000, duration: 0 } } }, "dog", "xxl"), { band: "xxl", price: 25_000, duration: 0 });
});

test("pricing columns and package options follow the organization's active bands, with Cat last and archived bands hidden", () => {
  assert.deepEqual(pricingColumns(legacy).map((column) => column.key), ["extra_small", "small", "medium", "large", "extra_large", "cat"]);
  assert.deepEqual(pricingColumns(withXxl).map((column) => `${column.key}:${column.label}`), ["extra_small:XS", "small:S", "medium:M", "large:L", "extra_large:XL", "xxl:XXL", "cat:Cat"]);
  assert.deepEqual(packageSizeOptions(withXxl).map((option) => option.value), ["extra_small", "small", "medium", "large", "extra_large", "xxl", "cat"]);
  assert.deepEqual(archivedDogBands(withXxl).map((item) => item.key), ["old"]);
  assert.equal(activeDogBands(withXxl).length, 6);
});

test("range labels come from the contiguous partition, honoring inclusive upper bounds", () => {
  assert.equal(rangeLabel(withXxl, "extra_small"), "< 5 kg");
  assert.equal(rangeLabel(withXxl, "small"), "≥ 5 – < 10 kg");
  assert.equal(rangeLabel(withXxl, "large"), "≥ 15 – ≤ 25 kg");
  assert.equal(rangeLabel(withXxl, "extra_large"), "> 25 – ≤ 35 kg");
  assert.equal(rangeLabel(withXxl, "xxl"), "> 35 kg");
  assert.equal(rangeLabel(withXxl, "cat"), "Kucing (terpisah)");
  assert.equal(rangeLabel(withXxl, "old"), "Diarsipkan");
});

test("layout draft validation mirrors the SQL rules as early feedback", () => {
  const rows = draftFromBands(withXxl);
  assert.deepEqual(validateLayoutDraft(rows), []);
  assert.deepEqual(validateLayoutDraft([]), [{ code: "count", row: null }]);
  assert.ok(validateLayoutDraft(Array.from({ length: MAX_ACTIVE_DOG_BANDS + 1 }, (_, index) => ({ id: null, label: `B${index}`, upper: String(index + 1), inclusive: false }))).some((issue) => issue.code === "count"));
  const bad = (change: (copy: LayoutDraftRow[]) => void) => { const copy = draftFromBands(withXxl).map((row) => ({ ...row })); change(copy); return validateLayoutDraft(copy).map((issue) => issue.code); };
  assert.deepEqual(bad((copy) => { copy[1].upper = "5"; }), ["order"]);
  assert.deepEqual(bad((copy) => { copy[1].upper = "4"; }), ["order"]);
  assert.deepEqual(bad((copy) => { copy[1].upper = ""; }), ["upper"]);
  assert.deepEqual(bad((copy) => { copy[1].upper = "0"; }), ["upper"]);
  assert.deepEqual(bad((copy) => { copy[1].upper = "1000"; }), ["upper"]);
  assert.deepEqual(bad((copy) => { copy[1].upper = "10.005"; }), ["decimals"]);
  assert.deepEqual(bad((copy) => { copy[0].label = "  "; }), ["label"]);
  assert.deepEqual(bad((copy) => { copy[0].label = "x".repeat(41); }), ["label"]);
  assert.deepEqual(bad((copy) => { copy[1].label = "xs"; }), ["duplicate_label"]);
  for (const text of Object.values(LAYOUT_ISSUE_TEXT)) assert.ok(text.length > 10);
});

test("draft payload never carries keys, closes the top band, and keeps ids only for existing bands", () => {
  const payload = draftToPayload(draftFromBands(withXxl));
  assert.equal(payload.length, 6);
  assert.deepEqual(payload.at(-1), { id: "id-xxl", label: "XXL", upper_kg: null, upper_inclusive: false });
  assert.deepEqual(payload[3], { id: "id-large", label: "L", upper_kg: 25, upper_inclusive: true });
  assert.ok(payload.every((item) => !("key" in item) && !("band_key" in item)));
  const added = addTopBand(draftFromBands(legacy), (label) => ({ id: null, label, upper: "", inclusive: false }), "XXL");
  const addedPayload = draftToPayload(added);
  assert.equal(added.length, 6);
  assert.equal(added[4].upper, "35", "previous top gets a provisional bound 10 kg above the last cutoff");
  assert.equal(addedPayload.at(-1)?.id, undefined);
  assert.equal(addedPayload.at(-1)?.upper_kg, null);
  const full = Array.from({ length: MAX_ACTIVE_DOG_BANDS }, (_, index) => ({ id: null, label: `B${index}`, upper: String(index + 1), inclusive: false }));
  assert.equal(addTopBand(full, (label) => ({ id: null, label, upper: "", inclusive: false }), "x").length, MAX_ACTIVE_DOG_BANDS);
});

test("reordering swaps which band covers a range but never moves a cutoff", () => {
  const rows = draftFromBands(legacy);
  const moved = moveBand(rows, 0, 1);
  assert.deepEqual(moved.map((row) => row.label), ["S", "XS", "M", "L", "XL"]);
  assert.deepEqual(moved.map((row) => row.upper), rows.map((row) => row.upper));
  assert.deepEqual(moved.map((row) => row.inclusive), rows.map((row) => row.inclusive));
  assert.equal(moved[0].id, "id-small");
  assert.deepEqual(moveBand(rows, 0, -1).map((row) => row.label), rows.map((row) => row.label));
  assert.equal(previewDraftLabel(rows, 25), "L");
  assert.equal(previewDraftLabel(rows, 25.01), "XL");
});

test("dynamic price form fields are keyed by band key, blank means base price, and values are validated", () => {
  const columns = pricingColumns(withXxl);
  assert.deepEqual(bandFieldNames("xxl"), { price: `${BAND_PRICE_PREFIX}xxl`, duration: `${BAND_DURATION_PREFIX}xxl` });
  const form = new FormData();
  form.set("band_price__xxl", "400000"); form.set("band_duration__xxl", "150"); form.set("band_price__small", "120000"); form.set("band_duration__small", "");
  const parsed = parseBandPriceForm(form, columns, false);
  assert.deepEqual("items" in parsed ? parsed.items : null, [{ band_key: "small", price: 120000, duration_minutes: null }, { band_key: "xxl", price: 400000, duration_minutes: 150 }]);
  const zero = parseBandPriceForm(form, columns, true);
  assert.deepEqual("items" in zero ? zero.items.map((item) => item.duration_minutes) : null, [null, null], "zero-minute services never send durations");
  for (const [name, value] of [["band_price__xxl", "-1"], ["band_price__xxl", "abc"], ["band_duration__xxl", "10"], ["band_duration__xxl", "1441"], ["band_duration__xxl", "20.5"]]) {
    const invalid = new FormData(); invalid.set(name, value);
    assert.ok("invalid" in parseBandPriceForm(invalid, columns, false), `${name}=${value}`);
  }
  assert.deepEqual(parseBandPriceForm(new FormData(), columns, false), { items: [] });
});

test("copy from previous band uses the nearest smaller dog band and never copies into the first or Cat", () => {
  const columns = pricingColumns(withXxl);
  assert.equal(previousColumnKey(columns, "xxl"), "extra_large");
  assert.equal(previousColumnKey(columns, "extra_small"), null);
  assert.equal(previousColumnKey(columns, "cat"), null);
  const values = { extra_large: { price: "300000", duration: "120" }, xxl: { price: "", duration: "" }, extra_small: { price: "1", duration: "2" }, cat: { price: "9", duration: "9" } };
  assert.deepEqual(copyBandValues(values, columns, "xxl").xxl, { price: "300000", duration: "120" });
  assert.deepEqual(copyBandValues(values, columns, "extra_small"), values);
  assert.deepEqual(copyBandValues(values, columns, "cat"), values);
});

test("starter template maps only the historical keys; other bands fall back to base prices", () => {
  assert.equal(starterIndexForBand("extra_small"), 0);
  assert.equal(starterIndexForBand("cat"), 5);
  assert.equal(starterIndexForBand("xxl"), null);
});

test("impact parsing and descriptions are plain, labelled and call out blocking package conflicts", () => {
  const impact = parseImpact({ pets_measured: 7, pets_rebanded: 2, package_conflicts: 1, by_change: [{ from: "extra_large", to: "xxl", count: 2 }] });
  assert.ok(impact);
  const lines = describeImpact(impact!, (key) => (key === "xxl" ? "XXL" : key === "extra_large" ? "XL" : key ?? ""));
  assert.deepEqual(lines, ["2 dari 7 anjing terukur akan berpindah kategori.", "2 anjing: XL → XXL", "1 paket aktif akan tidak cocok dengan kategori hewannya; simpan akan ditolak."]);
  assert.equal(parseImpact(null), null);
  assert.deepEqual(describeImpact(parseImpact({ pets_measured: 3, pets_rebanded: 0, package_conflicts: 0, by_change: [] })!, (key) => key ?? ""), ["Tidak ada anjing terukur yang berpindah kategori."]);
});

test("database error codes become owner-facing Indonesian text; dependency details are itemised", () => {
  for (const code of ["not_authorized", "dynamic_mode_required", "stale_layout", "invalid_size_layout", "active_package_size_would_change", "size_band_cat_permanent", "last_size_band", "size_band_not_archived", "rollback_blocked_custom_bands"]) {
    const text = mapSizeBandError({ message: code });
    assert.ok(text.length > 20 && !text.includes(code), code);
  }
  assert.match(mapSizeBandError({ message: "size_band_in_use", details: JSON.stringify({ manual_pets: 2, sellable_packages: 1 }) }), /2 anjing berukuran manual.*1 paket yang masih dijual/);
  assert.match(mapSizeBandError({ message: "size_band_in_use", details: JSON.stringify({ pets: 1, lines: 3, payroll: 1, prices: 2 }) }), /1 hewan.*3 baris booking\/invoice lama.*1 pengaturan payroll.*2 harga layanan/);
  assert.match(mapSizeBandError({ message: "active_package_size_would_change", details: JSON.stringify({ package_conflicts: 4 }) }), /^4 paket aktif/);
  assert.match(mapSizeBandError({ message: "something_unexpected" }), /belum tersimpan/);
  assert.match(mapSizeBandError(null), /belum tersimpan/);
  assert.match(mapSizeBandError({ message: "size_band_in_use", details: "not json" }), /masih dipakai/i);
});
