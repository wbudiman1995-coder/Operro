import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261025100000_size_band_booking_customer_adapters.sql"), "utf8");
const bookingAction = fs.readFileSync(path.join(root, "apps/web/src/app/bookings/actions.ts"), "utf8");
const bookingData = fs.readFileSync(path.join(root, "apps/web/src/lib/bookings.ts"), "utf8");
const invoiceData = fs.readFileSync(path.join(root, "apps/web/src/lib/invoice-workspace.ts"), "utf8");
const customerData = fs.readFileSync(path.join(root, "apps/web/src/lib/customer-360.ts"), "utf8");
const customerPage = fs.readFileSync(path.join(root, "apps/web/src/app/customers/page.tsx"), "utf8");
const customerForm = fs.readFileSync(path.join(root, "apps/web/src/components/pilot-forms.tsx"), "utf8");
const renewalAction = fs.readFileSync(path.join(root, "apps/web/src/app/pilot-actions.ts"), "utf8");

test("booking validation gets duration and price from the authoritative resolver without a caller-supplied organization", () => {
  assert.match(migration, /function app\.preview_booking_resolution\(p_items jsonb\)/);
  assert.doesNotMatch(migration, /preview_booking_resolution\(p_org/);
  assert.match(migration, /v_org := app\.fn_active_organization\(\)/);
  assert.match(migration, /app\.resolve_service_line\(/);
  assert.match(migration, /perform app\.size_layout_lock\(v_org\)/);
  assert.match(bookingAction, /rpc\("preview_booking_resolution"/);
  assert.doesNotMatch(bookingAction, /resolveServiceForPet|dogSizeFromWeight|pricingBand/);
});

test("read adapters consume server-resolved pet keys and tenant price rows", () => {
  assert.match(migration, /function app\.resolve_pet_pricing_keys\(p_pet_ids uuid\[\]\)/);
  assert.match(bookingData, /rpc\("resolve_pet_pricing_keys"/);
  assert.match(bookingData, /from\("service_band_prices"\)/);
  assert.match(invoiceData, /rpc\("resolve_pet_pricing_keys"/);
  assert.match(customerData, /rpc\("resolve_pet_pricing_keys"/);
});

test("package matching stays exact and renewal size mismatch is computed by SQL", () => {
  assert.match(migration, /app\.pet_pricing_key\(v_org, pet\.species, pet\.weight_kg, pet\.size\) is distinct from pkg\.size_band/);
  assert.match(migration, /'size_incompatible', v_size_incompatible/);
  assert.match(renewalAction, /Boolean\(data\.size_incompatible\)/);
  assert.doesNotMatch(renewalAction, /pricingBand\(/);
  assert.doesNotMatch(invoiceData, /nearest|sortOrder|upper_kg/);
});

test("Customer 360 uses live labels for pets and immutable snapshots for history", () => {
  assert.match(customerData, /sizeBand: petLabels\.get\(pet\.id\)/);
  assert.match(customerData, /pet_size_label_snapshot/);
  assert.match(customerData, /size_label_snapshot/);
  assert.doesNotMatch(customerData, /extra_small: "XS"|sizeBandForWeight/);
});

test("manual customer intake uses active tenant bands and still relies on the server write guard", () => {
  assert.match(customerPage, /from\("organization_size_bands"\)/);
  assert.match(customerForm, /dogBands\.map/);
  assert.match(customerForm, /bandForWeight\(dogBands/);
  assert.doesNotMatch(customerForm, /DOG_SIZE_BANDS|DogSizeBoundaries/);
});

test("adapter RPCs are authenticated-only and never expose internal org-aware resolvers", () => {
  assert.match(migration, /revoke all on function app\.resolve_pet_pricing_keys\(uuid\[\]\), app\.preview_booking_resolution\(jsonb\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function app\.resolve_pet_pricing_keys\(uuid\[\]\), app\.preview_booking_resolution\(jsonb\) to authenticated/);
});
