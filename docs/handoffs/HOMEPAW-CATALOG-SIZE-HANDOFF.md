# HomePaw catalog, size, duration and membership template

## What changed

- Customer intake, public registration and chat import offer dog/cat breed lists with an "other" entry. Staff and public forms accept up to five pets. Dog weight determines XS/S/M/L/XL on the server; cats use the Cat price band. A manually chosen dog size remains available when weight is unknown.
- **Layanan & Tim** contains an optional HomePaw starter table with prices and minutes for XS, S, M, L, XL and Cat. Import adds only services whose names are missing in that organization; it does not overwrite edited services, bookings, invoices or another organization. Owners can edit each price and each duration. Zero-minute paid add-ons remain allowed, but cannot be the only service in a booking.
- The booking wizard previews the price and required minutes for each selected pet. The server checks the slot is long enough. PostgreSQL resolves price/duration again when each grooming line is added and snapshots those values for invoicing.
- **Paket** offers Paw Prime (4 sessions, 15%, 7-day suggested visit gap), Paw Essential (2 sessions, 10%, 14-day gap), and Paw Basic (1 session, 5%, 30-day gap). These are *monthly* term templates; visit frequency is separate from billing renewal. Suggested price uses the selected service's size price × sessions × (1 − discount), and the owner can edit all terms before saving. Visit gap is informational; bookings are still confirmed in the calendar.
- A sized package requires a specific service and pet. PostgreSQL rejects a wrong-size sale, locks the size after the first sale, and rejects renewal at the old size if that pet grows. Existing purchased sessions remain available during their original term. Failed renewal rolls back its invoice.

The newer printed price list wins where it differs from the older admin table. Older-only Whitening and free Parfume remain in the optional template. Cat prices are taken from the older table where the printed list omitted Cat.

## Schema and regression evidence

Forward migrations: `20261017100000_homepaw_size_price_duration.sql` and `20261017110000_homepaw_membership_tiers.sql`. Existing rows are not bulk-modified. The gate migration manifest includes both.

`run_all_gates.sh` exited 0 on PostgreSQL 16 with `ALL GATES PASSED`, including its fresh migration replay, existing RPC/invoice/payroll suites, the new GATE 7f, and the three two-session booking concurrency cases. The new focused SQL smoke verifies XS/Cat/M/XL line snapshots, wrong-size purchase refusal through the authenticated invoice RPC, matching purchase invoice/ledger, monthly renewal versus two-week visit gap, and invoice rollback on a wrong-size renewal. The full raw gate log is outside Git at `E:\Claude\operro-release-backups\2026-09-30-before-homepaw-sizes\run_all_gates.log`.

App checks: booking tests 14/14, batch1a 108/108, batch1b 314/314; TypeScript and production Next build pass. The old size contract test was updated for the forward XS migration while retaining its old-migration assertions.

## Live release, 2026-09-30

- The linked Supabase project `tekgjynseoetoxestweb` was backed up before the change. The backup, checksums and push log are in `E:\Claude\operro-release-backups\2026-09-30-before-homepaw-sizes\` outside Git. `supabase db push` applied exactly the two forward migrations above; a subsequent dry run reported the remote database up to date.
- Git branch `fix/homepaw-catalog-breeds-durations` was pushed at SHA `ac9a44bc4848c1f7b854e7d17a75662437678b40`. Its parent is the customer/calendar fix `9d6267c`, so that prior work remains in the deployed tree.
- Vercel preview deployment `FSfZedsNXwsXGYqSALS9o3hPfiUE` reached Ready. Promoting it built a new Production-environment deployment `4Hn9R6NfzxSeQ65D7FKprvYypk6E`, also Ready, from the same SHA. Vercel lists `https://operro-web.vercel.app/` as its assigned production domain. The public production login page loads.
- A signed-in browser click-through of the new catalog, pet and membership screens is still outstanding. This browser has no active owner session on the production origin. Do not mistake deployment readiness or the SQL gate result for that UI proof. Preview and Production use the same Supabase project, so avoid disposable test purchases or invoices there.

## Manual owner QC

1. In HomePaw, open **Layanan & Tim**. Review the starter prices/minutes, then optionally click **Tambahkan layanan yang belum ada**. Edit Basic Grooming XS and Cat prices, save, reload, and confirm the change persists.
2. Create a customer with two dogs and a cat. Choose a breed from each list, try "Ras lain", enter weights 4, 12 and 26 kg, and confirm XS, M and XL. Confirm Cat is not assigned a dog size.
3. In Calendar, make a multi-pet booking. Confirm each service shows its own pet's price and minutes. Add Anti Kutu or Anti Fungal and confirm the price rises without lengthening the slot. Check the resulting invoice line totals.
4. In Paket, choose each membership template. Confirm the name, sessions, discount reference, suggested price, size and visit gap are editable. Sell an XS tier to the XS pet; verify a wrong-size pet cannot be selected, and the invoice/sessions appear once.
5. If that dog moves to another weight band, use a correctly sized new tier for the next term. The old tier cannot renew at the outdated size.

The visit gap does not create recurring appointments automatically. The manual signed-in QC above remains necessary.
