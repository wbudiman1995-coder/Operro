import assert from "node:assert/strict";
import Module from "node:module";
import test, { before } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { SizeBand, SizeBandWorkspace } from "../src/lib/size-bands";

// Component contract tests: they render the real client components to HTML (no Next.js runtime) with the
// Server Action modules replaced by inert stubs, and assert on the markup an owner/staff member would get.
let editorModule: typeof import("../src/components/size-band-editor");
let matrixModule: typeof import("../src/components/catalog-price-matrix");
let formsModule: typeof import("../src/components/pilot-forms");
let starterModule: typeof import("../src/components/homepaw-service-starter");

// "server-only" and the Server Action modules need a Next.js runtime; swap them for inert stubs at require time.
const STUBBED = new Set(["@/app/pilot-actions", "@/app/catalog/actions"]);
const inertActions = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : name === "then" ? undefined : async () => ({ error: null, success: null, ok: false, dynamic: false, options: [], prices: {} })) });
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: ModuleLoader };
const originalLoad = internals._load;

before(async () => {
  internals._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "server-only") return {};
    if (STUBBED.has(request)) return inertActions;
    return originalLoad.call(this, request, parent, isMain);
  };
  editorModule = await import("../src/components/size-band-editor");
  matrixModule = await import("../src/components/catalog-price-matrix");
  formsModule = await import("../src/components/pilot-forms");
  starterModule = await import("../src/components/homepaw-service-starter");
});

function band(key: string, label: string, upperKg: number | null, upperInclusive: boolean, sortOrder: number, extra: Partial<SizeBand> = {}): SizeBand {
  return { id: `00000000-0000-4000-8000-${String(sortOrder).padStart(12, "0")}`, key, kind: "dog_weight", label, sortOrder, upperKg, upperInclusive, status: "active", ...extra };
}
const cat: SizeBand = { id: "00000000-0000-4000-8000-000000001000", key: "cat", kind: "cat", label: "Cat", sortOrder: 1000, upperKg: null, upperInclusive: false, status: "active" };
const legacyBands = [band("extra_small", "XS", 5, false, 10), band("small", "S", 10, false, 20), band("medium", "M", 15, false, 30), band("large", "L", 25, true, 40), band("extra_large", "XL", null, false, 50), cat];
const dynamicBands = [
  band("extra_small", "XS", 5, false, 10), band("small", "S", 10, false, 20), band("medium", "M", 15, false, 30), band("large", "L", 25, true, 40),
  band("extra_large", "XL", 35, true, 50), band("xxl", "XXL", null, false, 60), cat, band("band_x", "Lama", 70, false, 70, { status: "archived" }),
];
const legacyWorkspace: SizeBandWorkspace = { settings: { mode: "legacy", layoutVersion: 3 }, bands: legacyBands, prices: {} };
const dynamicWorkspace: SizeBandWorkspace = {
  settings: { mode: "dynamic", layoutVersion: 7 }, bands: dynamicBands,
  prices: { "svc-1": { extra_large: { price: 300000, duration: 120 }, xxl: { price: 400000, duration: 150 } } },
};
const service = {
  id: "svc-1", name: "Basic Grooming", category: "Basic Grooming", duration: 60, additionalDuration: 0, price: 100000,
  priceExtraSmall: 99000, priceSmall: 120000, priceMedium: null, priceLarge: null, priceExtraLarge: 269000, priceCat: null,
  durationExtraSmall: 60, durationSmall: null, durationMedium: null, durationLarge: null, durationExtraLarge: 120, durationCat: null,
  speciesPricing: {}, fulfillmentModes: ["home", "in_store"], active: true,
};

test("SizeBandEditor: labelled rows, no keys exposed, accessible controls, announce region", () => {
  const html = renderToStaticMarkup(<editorModule.SizeBandEditor bands={dynamicBands} layoutVersion={7} />);
  assert.equal((html.match(/<fieldset/g) ?? []).length, 6, "one fieldset per active dog band");
  assert.match(html, /<legend[^>]*>Kategori 1<\/legend>/);
  for (const label of ["XS", "S", "M", "L", "XL", "XXL"]) assert.ok(html.includes(`value="${label}"`), label);
  assert.ok(!html.includes("extra_small") && !html.includes("extra_large") && !html.includes("xxl") && !html.includes("band_x"), "band keys never reach the markup");
  assert.ok(!/name="[^"]*key[^"]*"/i.test(html), "no key inputs");
  assert.match(html, /Naikkan XS/);
  assert.match(html, /Pratinjau dampak/);
  assert.match(html, /\+ Tambah kategori di atas/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Kategori baru memakai harga dasar layanan sampai harga per ukuran diisi/);
  assert.match(html, /Kategori diarsipkan \(1\)/);
  assert.match(html, /aria-label="Hapus permanen Lama"/);
  assert.ok(!html.includes("Simpan kategori ukuran"), "saving is only offered after a current impact preview");
  assert.match(html, /Tanpa batas atas/);
  assert.match(html, /Contoh: 3 kg → XS/);
});

test("SizeBandEditor is mobile safe: rows stack, nothing forces a fixed width, inputs can shrink", () => {
  const html = renderToStaticMarkup(<editorModule.SizeBandEditor bands={dynamicBands} layoutVersion={7} />);
  assert.ok(!/min-w-\[\d{3,}px\]/.test(html), "no fixed minimum widths that would overflow 375 px");
  assert.ok(!/<table/.test(html), "no table in the editor");
  assert.match(html, /grid min-w-0 gap-3 sm:grid-cols-/);
  assert.match(html, /flex flex-wrap/);
});

test("read-only members get a summary without any mutation control; platform mode control is separate", () => {
  const summary = renderToStaticMarkup(<editorModule.SizeBandSummary bands={dynamicBands} />);
  assert.ok(!summary.includes("<button") && !summary.includes("<input") && !summary.includes("<form"));
  assert.match(summary, /≥ 5 – &lt; 10 kg/);
  assert.match(summary, /&gt; 35 kg/);
  assert.ok(!summary.includes("Lama"), "archived bands are not listed to members");
  assert.match(renderToStaticMarkup(<editorModule.SizeBandModeControl mode="legacy" layoutVersion={3} />), /Aktifkan mode dinamis/);
  assert.match(renderToStaticMarkup(<editorModule.SizeBandModeControl mode="dynamic" layoutVersion={3} />), /Kembali ke mode lama/);
});

test("legacy rendering contract: the price matrix keeps its original field names and has no band fields", () => {
  const html = renderToStaticMarkup(<matrixModule.CatalogPriceMatrix services={[service]} sizeBands={legacyWorkspace} />);
  for (const name of ["price_extraSmall", "price_small", "price_medium", "price_large", "price_extraLarge", "price_cat", "duration_extraSmall", "duration_cat"]) assert.ok(html.includes(`name="${name}"`), name);
  assert.ok(!html.includes("band_price__") && !html.includes("layoutVersion") && !html.includes("Salin dari"));
  const withoutProp = renderToStaticMarkup(<matrixModule.CatalogPriceMatrix services={[service]} />);
  assert.equal(withoutProp, html, "omitting the workspace is identical to legacy mode");
});

test("dynamic rendering contract: matrix columns come from the organization's bands with copy-from-previous", () => {
  const html = renderToStaticMarkup(<matrixModule.CatalogPriceMatrix services={[service]} sizeBands={dynamicWorkspace} />);
  assert.ok(html.includes('name="band_price__xxl"') && html.includes('name="band_duration__xxl"') && html.includes('name="band_price__cat"'));
  assert.ok(!html.includes("price_extraSmall") && !html.includes('name="band_price__band_x"'), "no legacy fields, no archived band");
  assert.ok(html.includes('name="layoutVersion" value="7"'));
  assert.match(html, /<th class="p-2 text-left text-xs">XXL<\/th>/);
  assert.match(html, /Salin dari XL/);
  assert.ok(!html.includes(" ke XS\""), "the first band has nothing to copy from");
  assert.ok(html.includes(" ke S\"") && html.includes(" ke XXL\"") && !html.includes(" ke Cat\""), "every other dog band can copy; Cat never copies");
  assert.ok(html.includes('value="400000"') && html.includes('value="150"'), "stored xxl price and minutes are prefilled");
  assert.match(html, /Kategori baru memakai harga dasar sampai Anda mengisi harganya/);
});

test("ServiceForm: legacy payload unchanged, dynamic payload uses band keys and the layout version", () => {
  const legacy = renderToStaticMarkup(<formsModule.ServiceForm petTypes={[]} sizeBands={legacyWorkspace} />);
  assert.ok(legacy.includes('name="price_extraSmall"') && legacy.includes('name="duration_cat"') && !legacy.includes("band_price__"));
  const dynamic = renderToStaticMarkup(<formsModule.ServiceForm petTypes={[]} sizeBands={dynamicWorkspace} />);
  assert.ok(dynamic.includes('name="band_price__xxl"') && dynamic.includes('name="band_duration__cat"') && dynamic.includes('name="layoutVersion" value="7"'));
  assert.ok(!dynamic.includes("price_extraSmall") && !dynamic.includes("band_x"));
  assert.equal(renderToStaticMarkup(<formsModule.ServiceForm petTypes={[]} />), legacy, "no workspace = legacy form");
});

test("PackageForm starts from the fixed legacy options; dynamic options arrive from SQL-backed data", () => {
  const html = renderToStaticMarkup(<formsModule.PackageForm services={[]} />);
  for (const label of ["XS", "S", "M", "L", "XL", "Cat"]) assert.ok(html.includes(`>${label}</option>`), label);
  assert.ok(!html.includes(">XXL</option>"));
});

test("HomePaw starter in dynamic mode follows the tenant bands and marks bands the template does not price", () => {
  const html = renderToStaticMarkup(<starterModule.HomepawServiceStarter sizeBands={dynamicWorkspace} />);
  assert.match(html, /<th class="p-2">XXL<span/);
  assert.match(html, /— \(harga dasar\)/);
  assert.match(html, /XL &gt; 25 – ≤ 35 kg|&gt; 25 – ≤ 35 kg/);
  const legacy = renderToStaticMarkup(<starterModule.HomepawServiceStarter sizeBands={legacyWorkspace} />);
  assert.ok(!legacy.includes("harga dasar)") && legacy.includes("XS &lt;5 kg"));
  assert.equal(renderToStaticMarkup(<starterModule.HomepawServiceStarter />), legacy);
});
