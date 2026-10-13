# Hosted staging / manual QC script — real invitation and multi-organization flow (parity #41)

Run this on a **hosted staging** project with **non-production data**, using mailboxes you control. It is the part of
"accounts and permissions" that local SQL and browser tests cannot prove: real e-mail delivery, real Supabase Auth
verification, real session refresh and the Vercel deployment. Nothing here was run by the change that added this file; it
is a script for the owner/QA person. Tick as you observe. Stop at the first red item and file it.

Preconditions

- [ ] Staging Supabase project has all migrations through `20261031160000` applied (`select app.schema_version();`).
- [ ] Staging web deployment has `NEXT_PUBLIC_SUPABASE_URL` / anon key of **staging** (never production).
- [ ] Auth e-mail confirmation is **on**; SMTP sends to a real inbox you control.
- [ ] You hold: the platform-owner login (the account whose e-mail is hard-wired as owner), and three independent mailboxes
      `qa-owner@`, `qa-admin@`, `qa-helper@` plus one unrelated mailbox `qa-stranger@`.
- [ ] Browser profile for each person (or private windows) so sessions do not mix.

## 1. Platform owner provisions and invites

1. Sign in as the platform owner → `/platform`. Create organization **QA Alpha** (it starts with the four system roles).
2. Issue an invitation to `qa-owner@` as **Pemilik**. The page shows the link **once** — copy it; reload and confirm the link
   cannot be shown again (only a status row remains).
   - [ ] Reloading shows no token anywhere (page source, network responses).
3. Issue invitations to `qa-admin@` (Admin) and `qa-helper@` (Bantuan Operro) the same way.
4. Re-issue to `qa-admin@`: the **older** link must become unusable (step 6 tests it).

## 2. Claim paths (open each link in a fresh private window)

| # | Do this | Expect |
|---|---|---|
| 2.1 | Open the `qa-owner@` link, **Buat akun** with `qa-owner@`, set a password | "Periksa email…" message; no workspace yet |
| 2.2 | Open the verification e-mail link, then the invitation link again, sign in | Lands on QA Alpha; role Pemilik; `/settings/access` visible |
| 2.3 | Reuse the same invitation link | "Link tidak tersedia, kedaluwarsa, atau sudah digunakan" |
| 2.4 | Open the `qa-admin@` **older (revoked)** link while signed in as qa-admin | Same "tidak tersedia" message — not a generic error |
| 2.5 | Sign in as `qa-stranger@` and open the `qa-helper@` link | "Masuk menggunakan email penerima undangan yang sudah diverifikasi." and **no** membership created |
| 2.6 | Sign up `qa-helper@` but do **not** verify the e-mail, then claim | Refused (unverified); after verifying and retrying, accepted |
| 2.7 | Wait for / simulate expiry (7 days, or ask Operro to set `expires_at` in staging SQL) | "tidak tersedia/kedaluwarsa" |
| 2.8 | Operro suspends QA Alpha, then an unclaimed link is opened | "Workspace ini sedang tidak aktif…" (not "link invalid") |
| 2.9 | A transient failure (turn Wi-Fi off, press *Terima undangan sekarang*) | "gangguan sementara… Link Anda belum tentu bermasalah" — never "link invalid" |

## 3. Role boundaries inside QA Alpha

1. As the QA owner: `/settings/access` → give **Admin** the checklist `booking.read, customer.read, finance.read` only.
2. As `qa-admin@`: confirm bookings/customers/finance read pages work; `/payroll`, `/settings/access`, `/settings/health`,
   `/settings/storage` export panel are refused or hidden; trying `/settings/access` shows an access notice, not data.
3. As the QA owner: attempt to give Admin `roles.manage` — not offered (not in the checklist options).
4. As `qa-helper@` (Bantuan Operro): operations visible; **no** payroll, finance totals, audit viewer or access page; direct
   URL entry to `/payroll` and `/finance` shows the restricted notice, never a zero.
5. As the platform owner (not a member): switch into QA Alpha from `/organizations`, change the Admin checklist, confirm the
   tenant Admin cannot do the same.

## 4. Multi-organization

1. Provision **QA Beta**; invite `qa-admin@` there as Admin.
2. As `qa-admin@` claim it with the existing account (signed in): both workspaces now appear at `/organizations`.
3. Switch Alpha ↔ Beta repeatedly: each shows only its own customers, dashboard figures, WhatsApp drafts and cash register.
4. Refresh the token (wait for the 60-minute refresh or sign out/in): the active workspace and permissions stay correct.
5. Suspend QA Beta from `/platform`: Beta's tenant users lose access immediately (stale tab → next action refuses); the
   platform owner can still open Beta to inspect; QA Alpha is unaffected.
6. Re-activate Beta; access returns without re-inviting.

## 5. Evidence to keep

Screenshots of 2.3–2.9, the access pages in step 3, the organization list in step 4; the staging `schema_version`; the
build commit. Attach them to the release ticket. Do **not** attach invitation links or e-mail headers.

## 6. Readiness and post-conditions the database can prove

These do **not** replace the manual steps above; they catch the problems a person would otherwise have to notice by eye. Neither
creates an invitation or sends mail.

1. **Before you start and after each section:** sign in as the platform owner and read **Kesiapan akses** at the top of `/platform`.
   It lists, from existing records only, the organizations that need attention: no active owner (and whether an owner invitation is
   waiting, expired or missing), suspended workspaces, expired unclaimed invitations, and how many people are active in more than one
   organization. It shows counts and fixed flags, never an e-mail, token or user id. Expected right after step 1: QA Alpha shows
   `no_active_owner` + `owner_invitation_pending`; after 2.1 that flag is gone; after step 4 the multi-organization count is at least 1.
2. **After the manual run:** run the read-only post-condition script on the staging database and keep its output:
   ```bash
   psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/runbooks/staging_access_checks.sql
   ```
   Every row is `(check_name, ok, detail)`; any `ok = f` is a finding. It checks that invitation tokens are stored only as SHA-256
   hashes, every invitation lives exactly seven days, there is at most one pending invitation per address and organization,
   every accepted invitation produced the membership it named, no Admin role holds `roles.manage` or `users.manage`, no pending
   invitation points at a suspended workspace, and every trial or active workspace has an active owner or a waiting owner invitation.
   Rows with `ok` empty are information (multi-organization people, suspended memberships, schema version).

What neither proves: that the e-mail arrived, that the person clicked the right link, or how the hosted deployment behaves. Those are
steps 2 to 4 above and only a person with the mailboxes can tick them.

## 7. Evidence table (copy into the release ticket)

| Item | Result (tick or paste) | Who / when |
|---|---|---|
| Section 1 to 4 steps all ticked, with screenshots of 2.3 to 2.9 | | |
| **Kesiapan akses** after step 1, after 2.1 and after step 4 (screenshots) | | |
| `staging_access_checks.sql` output with no `ok = f` row | | |
| Staging `app.schema_version()` and build commit | | |
