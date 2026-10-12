# Browser pass — performance dashboard (10 Oct 2026, local only)

Environment (all disposable, deleted afterwards): a private Supabase CLI stack (`supabase start`, project id `operro-perf-dashboard-local`, PostgreSQL 17.6, GoTrue, PostgREST, Storage; copy of this repo's `supabase/` directory in WSL `/tmp/sbperf`, ports 54321+) started with this repo's migrations including `20261030100000` (`select app.schema_version()` returned `20261030100000`). `apps/web` ran with `next dev -p 3010` against it via a git-ignored `.env.local` (publishable key of the local stack; deleted afterwards). Four test accounts `owner|north|nofin|cust@perf-browser.test` were created through the local GoTrue sign-up endpoint (no service-role key), memberships and the fixture organization "Perf Browser A" through SQL on the local database (fixture = the data of `supabase/tests/20261030100000_test_performance_dashboard.sql`, branch time zone set to Asia/Jakarta). No real account, no production data, no remote project.

The Browser pane was often not displayed, so `read_page` returned an empty tree and `innerText` was empty; page checks were made with `textContent` and DOM queries via `javascript_exec`, plus screenshots where the pane drew.

| Scenario | Result |
|---|---|
| Owner, `?period=month` (1–10 Okt 2026 vs 21–30 Sep) | Operations 3 / 1 / 1 / 1 (+1, +50% on completed); IDR issued Rp 1.650.000 (5), collected Rp 1.115.000 (5), refunds Rp 130.000 (2), outstanding Rp 550.000 (2, 1 overdue); USD 50 / 40 / 5 / 50 shown separately; multi-currency note; "1 payment on a voided invoice" warning; sources instagram 2/1/2, Walk-in 0/1/1, Teman 1/0/0, Tanpa sumber 2/0/0 — identical to the PG16 test's expected values |
| Owner, default (no query) | "Hari ini · 10 Okt 2026" vs "9 Okt 2026"; existing four "today" cards unchanged |
| Custom range through the GET form (5–8 Okt 2026) | URL `?period=custom&from=2026-10-05&to=2026-10-08`; label and comparison "Dibanding 4 hari sebelumnya · 1–4 Okt 2026"; inputs `max` = today |
| Custom range of exactly 366 days (`2025-10-10`..`2026-10-10`) | Accepted; comparison "366 hari sebelumnya · 9 Okt 2024 – 9 Okt 2025"; all three sections rendered |
| 367 days (`2025-10-09`..) | Alert "Rentang maksimal 366 hari. Menampilkan hari ini."; page falls back to today |
| Empty period (1–10 Jan 2026) | Operations and sources show their empty states; finance shows zero period figures plus the current outstanding position |
| `north` (finance.read + booking.read + customer.read, North branch only) | Finance IDR issued 350.000 (3), collected 215.000 (4), refunds 30.000 (1) (South rows absent); sources card "Tidak tersedia untuk peran ini — … hanya tersedia bagi peran dengan akses semua cabang" |
| `cust` (customer.read + branches.all only) | Operations and Finance cards "Tidak tersedia untuk peran ini" naming booking.read / finance.read, no money anywhere in the section; sources table with counts and "—" in the two capability-gated columns |
| `nofin` (booking.read only) | Redirected by the existing landing rule to `/my-schedule` (no dashboard surface for that role) |
| Card visibility | Settings form lists seven cards; saving through the form stored the complete seven-key allowlist (`organizations.settings` read back from the database); with `performance_finance=false` stored, a reload shows no finance section and the form shows it unchecked |
| Mobile 375 px | No horizontal overflow from the new section (offender scan empty; the source table scrolls inside its own container); screenshots reviewed |
| Console | No console errors on the dashboard pages |

Observations that are not defects of this change but should be known:
- A settings save (`POST /dashboard`) took 24–43 s in the dev server log while the Browser pane was hidden, although the same RPC through PostgREST answered in 0.09 s and `pg_stat_activity` showed no active query; most likely the hidden pane throttling the streamed server-action response. Not reproduced with a displayed pane; not investigated further.
- The existing upcoming-bookings list shows a *completed* booking (existing behaviour of `loadDashboardData`, untouched).
- Scripted login by DOM value injection did not work against the controlled login form in a hidden pane; role switching used the GoTrue password grant (`curl`) and the `sb-127-auth-token` cookie instead.

Not covered: a real staging project, real PostgREST exposure on a hosted Supabase project, Safari/Firefox, keyboard-only navigation, and a screen reader.
