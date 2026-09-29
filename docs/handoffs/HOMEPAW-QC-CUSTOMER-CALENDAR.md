# HomePaw QC: customer intake, service time, calendar booking

Branch: `fix/homepaw-qc-customer-calendar` (based on integration `7f62870`).

## Fixed

- Customer and public registration addresses use a bundled Indonesian hierarchy (38 provinces, 514 regencies/cities, 7,285 districts); server accepts only valid combinations. Existing legacy address values remain visible on edit. The Jakarta administrative-city wording is matched to older short service-area labels.
- Staff can create a customer with 1–5 dogs/cats and an optional full home-service address in one database transaction. Public registration now collects the same core address and pet details, retains its optional styling photos, and uses “pet”.
- Public registration failed at submit because `customer_onboarding_submissions` had a standard audit trigger but no `created_by`/`updated_by` columns. The forward migration adds them and exposes only two token-scoped public RPC wrappers, without granting anonymous access to the whole `app` schema. An anonymous GET → two-pet POST → owner approval is verified against PostgreSQL 16.
- Service catalog create/edit supports a paid, zero-minute add-on. The service and grooming-line constraints now allow zero minutes; a real authenticated assembly RPC test proved a Rp 25,000 line persists with zero minutes. Each booked pet must still have a positive-duration main service.
- Calendar empty half-hour slots open the existing booking wizard with date, branch, and day-view groomer preselected. Branch wall time is converted to UTC before submission, so a Jakarta 09:00 click saves at 09:00 Jakarta. The separate Booking creation form and Booking navigation entry are gone; the old Booking list remains a read-only route. Kunjungan is explicitly historical, rejects future visits, and resolves its branch-local date correctly.

## Verification

- `npm run typecheck -w apps/web`, `npm run lint -w apps/web`, and `npm run build -w apps/web`: passed.
- Booking tests: 13/13; Batch 1A: 108/108; Batch 1B: 314/314. The existing size-price contract test was updated to assert the new client **and** database size validation.
- `integration/homepaw_qc_db.sh` + `integration/homepaw_qc_smoke.sql`: fresh full migration replay on disposable PostgreSQL 16, anonymous submit, staff household creation, admin approval, Jakarta coverage alias, and zero-time paid line all passed.
- `integration/run_combined_gates.sh`: `ALL GATES PASSED`, including GATE 8 concurrency. Raw log: `docs/handoffs/logs/INTEGRATION/run_all_gates.log`.
- Backed up the linked Supabase project's roles, schema, data, and migration history outside Git at `E:\Claude\operro-release-backups\2026-09-29-before-homepaw-qc`. Applied the two forward migrations to the linked project. A second dry run reported `Remote database is up to date.`

## Remaining live QC

Before calling the change fully accepted, test on the deployed site as an owner: create a customer with two pets and a structured address; submit a new one-time public registration link from an anonymous session and approve it; save a zero-minute paid treatment and book it alongside a timed main service; click an empty groomer slot in Calendar and confirm the saved booking stays in the clicked hour. Check both mobile and desktop. Production and preview share the same Supabase project, so use an intentional QC record that can be removed afterwards.
