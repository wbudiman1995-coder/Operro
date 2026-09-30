# HomePaw registration, catalog controls, usage and calendar

## Product behavior

- **Layanan & Tim (`/catalog`)** now starts with a category-grouped matrix for editing every service's XS/S/M/L/XL/Cat price and duration. Existing service editing still controls the base price, base duration, category, active status and fulfillment modes. Zero-time paid add-ons remain zero minutes.
- **Public registration (`/join/[token]`)** accepts multiple dogs/cats. Owners enter whole kilograms and grams; the dog size is derived from weight and is not shown in the public form. A checked recipient box copies owner name and phone. Styling photos are optional. The customer can share current device coordinates or paste a Google Maps link. Existing RT/RW, Kelurahan/Desa, postal code and landmark fields remain.
- **Registration review (`/customers/onboarding`)** is the admin inbox. A customer is not created until approval. An admin can correct owner, recipient, address, Google Maps link, region, and pet details; add/remove pets; then save and approve. An optimistic timestamp prevents a stale correction overwriting newer data. The Maps share link is kept on the new customer's default address, including short links that do not expose coordinates.
- **Data & storage (`/dashboard`, `/settings/storage`)** shows each organization's stored file count and bytes. A platform admin also sees project-level file and database bytes against *reference* Supabase Free limits. This is a point-in-time estimate, not the Supabase billing measurement. Each organization can request a capacity increase; Operro staff review and bill manually. No charge is made in the app. Vercel usage is linked separately, since Supabase storage is not Vercel deployment storage.
- **Calendar (`/schedule`)** displays Kabupaten/Kota and Kecamatan for home-service bookings, with a client-side Kabupaten/Kota filter. When the 400-booking server cap is hit, the UI warns that the filtered result may be partial.

## Verification

- Typecheck, lint, Next production build: exit 0.
- Booking tests: 14/14; batch1a: 109/109; batch1b: 314/314.
- Full `run_all_gates.sh` database stages 4–8: `ALL GATES PASSED` on disposable PostgreSQL 16. The complete wrapper's stages 1–3 passed before Docker stopped the disposable container; stages 4–8 were then rerun from the same gate script with a Docker client shim. The gate run included all migrations, RPC/payment/payroll suites, HomePaw intake and size smokes, and all three two-session completion races.
- The new SQL smoke verifies authenticated amendment, stale edit rejection, approval using amended data, Google Maps link persistence, tenant-only storage visibility, one open upgrade request per organization, and cross-org denial. The three new migrations replayed cleanly from zero.

## Manual QC still needed on live origin

1. As an owner, change one XS price and one duration in `/catalog`, reload, and confirm both stick. Make a calendar booking and compare its price/minutes. Restore any test price afterward.
2. Create a fresh public link; submit two pets with KG/G, no photos, recipient=same, and a Google short link. In `/customers/onboarding`, edit one field, save, approve, and check Customer 360 address and Maps link. Do this with a non-customer test phone and remove the test data afterward.
3. On `/schedule`, confirm city/district on home-service cards and the city filter. In `/settings/storage`, confirm only your organization is visible and submit one test request. A platform admin should see the request and may mark it declined after the test.

No signed-in production browser test is claimed here. Supabase Free figures in the interface are references and may differ from the project's actual plan or billable average storage.

Official references: [Supabase billing](https://supabase.com/docs/guides/platform/billing-on-supabase), [Supabase storage usage](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size), [Vercel usage](https://vercel.com/docs/pricing/manage-and-optimize-usage).
