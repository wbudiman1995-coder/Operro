# Handoff: HomePaw parity sections 23-26 (package/membership lifecycle)

## Review round 3 (2026-09-26) — READ THIS FIRST, supersedes everything below

Codex reviewed commit `6b4dc27` (the "Review round 2" work below) against
`docs/handoffs/S23-S26-REVIEW-86ad714.md`'s intent and found 5 remaining
gaps -- some were incomplete fixes from round 2 (idempotency only compared
branch/membership, not the other caller-supplied fields; the pet-scope
compatibility rule was too strict and blocked a legitimate case; the
reconcile provenance checks stopped short of the specific event), one was
a genuinely new architectural gap (the renewal preview was advisory only,
with no binding between what was previewed and what was actually charged),
and one was the previously-disclosed incomplete item (guarded purchased-
term editing) that needed to actually be built, not just disclosed.

**All 5 findings are now fixed and independently verified on PostgreSQL 16,
including a genuine populated-database upgrade replay strengthened to
content-hash comparison (not row-count) per this round's explicit ask.**
Live browser verification (see "Browser verification" below) additionally
found and fixed a 6th, UI-only defect: a stale-prop bug in
`MembershipManager` let the purchased-term correction form silently revert
a just-completed renewal's expiry date. This was not caught by any SQL/JS
contract test because those exercise the RPC directly with correct inputs;
it only surfaced by driving the actual React component through a real
renewal-then-correction sequence in a browser.

### Current authoritative status (sections 23-26)

| Section | Status | Evidence |
|---|---|---|
| 23 — Coverage detection | **Done** | Booking wizard/Customer 360 show available-vs-reserved; per-pet eligibility enforced server-side; two-connection race proven (round-1 log, untouched this round) |
| 24 — Packages and memberships | **Done** | Catalog UI (recurrence/per-pet/service/rollover/price/validity); per-pet sale; paid renewal creates a real invoice with a server-validated preview binding; rollover_policy actually governs renewal; pet/service catalog-drift compatibility corrected |
| 25 — Membership administration | **Done** | Filters/urgency/history/renew/archive/reconcile, AND (this round) guarded purchased-term editing (`app.update_customer_package_terms` + UI form) -- the item previously disclosed as incomplete is now implemented and tested |
| 26 — Subscription reconciliation | **Done** | Deep reservation/ledger link checks, invoice-linkage checks tied to the SPECIFIC purchase/renewal event (not just customer+product), historical `source_invoice_id` validated the same way, guarded revision-checked repair unchanged |

### Finding 1 — renewal idempotency still ignored caller-supplied material inputs (FIXED)

Round 2 only compared `branch_id` and `renewal_of` (membership) before
returning a cached invoice on retry; `p_issued_at`/`p_due_at`/
`p_admin_notes` (all genuinely caller-supplied) could silently differ on a
"retry" and the caller would get back an invoice with terms it never
actually confirmed. **Fixed** in both `renew_customer_package` and
`create_package_invoice` (which had the identical gap, not previously
caught): the idempotent-return check now compares `issued_at` (exact),
`due_at` (null-safe), and a normalized `admin_notes` (same `left(nullif(
trim(...)),2000)` normalization used at insert time) alongside
branch/membership. An identical retry (including after a later catalog
price change) still returns the original invoice unchanged; a retry with
any one of these fields genuinely different is rejected with
`request_key_reused_for_different_renewal`/`..._invoice`. New SQL tests:
S43/S44 (identical retry survives a price change), S44b (different
`issued_at` rejected), S44c (different `admin_notes` rejected).

### Finding 2 — the renewal preview was advisory only (FIXED)

The preview showed terms but nothing bound them to the actual write: the
submit button was enabled while the preview was loading, missing, or
failed; a preview error blocked ever retrying; and the RPC re-read live
catalog state with no cross-check against what the staff member actually
saw, so a catalog edit between preview and submit could silently change
the charged terms.

**Fixed:**
- `app.preview_package_renewal` now returns a `terms_fingerprint` -- a pure,
  query-free `md5` digest (`app.fn_renewal_terms_fingerprint`, `language
  sql immutable`, computed from the SAME already-fetched `pkg`/`cp` rows
  the caller already holds, never a second query, so there is no
  read-then-use race window) over every field the charge depends on:
  catalog price/currency/sessions/rollover/recurrence/per_pet/service/
  active, and the membership's own status/pet/service/expiry/balance/held-
  count.
- `app.renew_customer_package` now requires `p_terms_fingerprint` for a
  NEW request (no existing invoice for that `request_key`): missing ->
  `renewal_preview_required`; present but stale (recomputed under the SAME
  row lock and mismatching) -> `renewal_terms_changed_since_preview`
  (`40001`, matching the repair/stale-revision convention). An idempotent
  RETRY (an invoice already exists for that key) never re-checks the
  fingerprint at all -- a genuine retry must still survive a later catalog
  change, which a fingerprint re-check would defeat.
- UI (`membership-manager.tsx`): submit requires `canSubmitRenewal` --
  `Boolean(renewalPreview) && !renewalPreview.blockingReason &&
  !loadingPreview && !renewPending` -- not merely "no blocking reason yet".
  A failed preview shows an explicit "Coba lagi" (retry) button. The
  preview is invalidated (cleared, forcing a reload) after every mutation
  that could change it: a successful renewal, repair, status change/
  archive, or terms correction. The renewal form submits
  `renewalPreview.termsFingerprint` as a hidden field. Pet/service scope in
  the preview panel is shown via the row's own resolved names
  (`row.petName`/`row.serviceName`), not raw UUIDs.
- New SQL tests: S48b (no fingerprint -> refused), S48c (stale fingerprint
  after a live price change -> refused, `40001`), S48d (reloading the
  preview then resubmitting the SAME request succeeds and charges the NEW
  price -- a deliberate re-confirmation, not a permanent block), plus S20/
  S43 proving a garbage/stale fingerprint is silently ignored on a genuine
  retry (by design).

### Finding 3 — catalog service changes could still renew incompatible entitlements (FIXED, and the round-2 pet check was corrected)

Two issues: (a) only `per_pet` was checked, never `service_id`; (b) the
round-2 `per_pet` rule (`pkg.per_pet <> (cp.pet_id is not null)`) was
**too strict** -- a sale may legitimately bind an optional pet even when
`per_pet=false` (pet presence alone is not proof the catalog changed), so
that rule wrongly blocked a real, legitimate case forever.

**Fixed, in both `renew_customer_package` and `preview_package_renewal`
identically:**
- `v_pet_incompatible := pkg.per_pet and cp.pet_id is null` -- the ONLY
  unsafe drift is the catalog NOW requiring a pet for a membership sold
  with none at all. `per_pet` going `true -> false` while a pet stays
  optionally bound is explicitly compatible (this is the round-2 bug fix).
- `v_service_incompatible := cp.service_id is not null and pkg.service_id
  is not null and cp.service_id <> pkg.service_id` -- `cp.service_id` is
  the immutable purchase-time snapshot (set once by `create_package_invoice`,
  never touched by renewal); `NULL` on either side ("any service") is never
  itself a mismatch by definition -- only two different SPECIFIC services
  are incompatible.
- Preview exposes both as separate flags (`pet_scope_incompatible`,
  `service_scope_incompatible`) so the UI/tests can tell which one fired.
- New SQL tests (S49-S56): the bug-fix case (per_pet true->false with an
  optionally-bound pet stays COMPATIBLE), the genuine incompatibility case
  (per_pet false->true with no pet ever bound), service A->B (incompatible,
  with a REAL renewal attempt refused, not just a preview check, and a
  genuinely HELD reservation present throughout via `per_pet_cp`), service
  A->NULL and NULL->A (both compatible), and a real successful renewal
  under a legitimate broadened-then-narrowed service scope.

### Finding 4 — reconciliation still missed historical and wrong-renewal associations (FIXED)

Two gaps: (a) `customer_packages.source_invoice_id` (the historical
purchase link, predating the ledger's own `invoice_id` column) was only
ever checked for NULL, never actually validated when present; (b) the
ledger-level `invalid_invoice_links` check accepted any invoice matching
"same customer, same package", which two separate purchases OR two
separate renewals of the same membership could both satisfy without
actually being the CORRECT specific invoice for that specific event.

**Fixed:**
- New `v_invalid_source_invoice` check on `customer_packages.source_invoice_id`
  when non-null: real invoice, right customer, right package line,
  non-void status, AND a matching session-count snapshot against the
  purchase ledger row -- as a read-only cross-check, never by mutating the
  immutable ledger row itself. New `invalid_source_invoice` manual-review
  flag.
- The ledger-level check is now tied to the SPECIFIC event: a `'purchase'`
  row must match `cp.source_invoice_id` exactly; a `'renewal'` row's
  invoice must match BOTH `metadata->>'renewal_of' = cp.id` AND
  `invoices.request_key = customer_package_ledger.request_key` (both are
  stamped identically by `renew_customer_package`) -- so two renewals of
  the same membership can no longer cross-link each other's invoice either.
- New SQL tests (S60-S67): a healthy baseline, wrong-CUSTOMER source
  (a second customer added to the fixtures specifically for this), wrong-
  PACKAGE source, VOID-status source, a MISMATCHED session-count snapshot
  (999 vs the real ledger delta, constructed as a standalone raw
  invoice+line since `invoice_lines` is also append-only and can't be
  corrupted via UPDATE), same-membership-but-wrong-renewal (request_key
  mismatch), and a legacy NULL-invoice_id renewal row (pre-migration data).

### Finding 5 — guarded purchased-term editing (NOW IMPLEMENTED, was disclosed incomplete)

New `app.update_customer_package_terms(p_customer_package, p_revision,
p_reason, p_expires_at, p_pet, p_service) returns customer_packages`.
Allowed-field matrix: `expires_at` is always correctable (while not
`canceled`) since it never touches the ledger or any past reservation
(`reserve_package_session` re-checks it live, never snapshots it). `pet_id`/
`service_id` are correctable ONLY while the entitlement has never been
touched at all -- no `package_reservations` row of ANY status has ever
existed for it, and it has never been renewed (`renewal_count = 0`) --
refused with a precise `entitlement_scope_locked_after_first_reservation`/
`_after_renewal` otherwise, explaining exactly why and that `expires_at`
alone remains open. Guarded like every other write RPC on this branch:
`membership.manage`, row locked first, revision-checked (`40001` on stale,
matching `repair_customer_package_balance`), a mandatory non-empty reason,
and a full before/after audit row in `timeline_events`
(`membership.terms_corrected`). Never touches `sessions_remaining`,
`package_id`, `customer_id`, or `source_invoice_id` -- no balance edit, no
retroactive invoice/ledger rewrite. New UI form ("Koreksi data paket") in
`membership-manager.tsx`, gated on `canManage`, with the pet/service
selects disabled client-side once `row.hasAnyReservationHistory` (a real
signal from a bulk, per-organization reservation-existence query, not an
unbounded scan). New SQL tests (S68-S76): allowed correction (pet+service+
expiry, with audit verification and unchanged balance/invoice total),
stale revision, unauthorized (read-only) role, cross-customer pet
rejection (a second customer/pet fixture added specifically for this),
scope-locked rejection on a membership with reservation history, and
`expires_at`-only correction remaining open on that same locked membership.

### Verification — review round 3, exact results

All commands re-run against the fully amended migration and app code.
Logs under `docs/handoffs/logs/S23-S26/` (absolute path:
`E:\Claude\operro-review-s23-s26\docs\handoffs\logs\S23-S26\`).

| Command | Result | Log file |
|---|---|---|
| `npm run typecheck -w apps/web` | exit 0, clean | `npm_typecheck_review3.log` |
| `npm run lint -w apps/web` | exit 0, clean | `npm_lint_review3.log` |
| `npm run test:batch1a -w apps/web` | **107/107 pass** | `npm_test_batch1a_review3.log` |
| `npm run test:batch1b -w apps/web` | **283/283 pass** (up from 272; contract suite extended for all 5 findings) | `npm_test_batch1b_review3.log` |
| `npm run build -w apps/web` | exit 0 — 31 routes | `npm_build_review3.log` |
| PostgreSQL 16 — GATE 4-6 + both SQL smoke tests | **all pass**, 123 `PASS` notices total, zero errors | `pg16_migration_gate4_6_smoke_review3.log` |
| PostgreSQL 16 — GATE 7 (real authenticated-role integration, literal script) | **PASSED** | `pg16_gate7_gate8_review3.log` |
| PostgreSQL 16 — GATE 8 (concurrency harness, literal script) | **PASSED** | `pg16_gate7_gate8_review3.log` |
| PostgreSQL 16 — `integration/migration_upgrade_replay.sh` (strengthened: content-hash comparison, not row count) | **PASSED** | `pg16_migration_upgrade_replay.log` |

`integration/package_lifecycle_smoke.sql` grew from 54 to **86 PASS
notices** (S1-S76, several with lettered sub-assertions); the new ones
(S39 onward were already present from round 2 for rollover; S42 onward are
new this round) cover all 5 findings above with real fixtures and real RPC
calls, not source-string assertions -- per the explicit instruction to
favor behavior tests.

**`integration/migration_upgrade_replay.sh` was strengthened per this
round's explicit ask** (a row count staying the same does not prove a row
is untouched): it now hashes the pre-existing purchase ledger row's full
content (id, customer_package_id, delta, reason, notes, occurred_at,
created_at) and the corresponding `customer_packages` balance/source
association BEFORE the upgrade, recomputes the identical hash AFTER, and
fails unless they are byte-identical; it also confirms the row's new
`invoice_id` column is left NULL (never backfilled -- structurally would
require the very UPDATE that was removed) and that append-only enforcement
on `customer_package_ledger` is still active after the upgrade (a live
UPDATE attempt against it must still fail with the same trigger error).

### Browser verification

Performed live against a disposable local stack for this worktree only
(Supabase on ports 54351-54354, `project_id=operro-review-s23s26-local`;
Next.js dev server via `npm run dev -w apps/web`), using the in-app browser
tool. `supabase/config.toml` was restored to its committed state
(`git checkout -- supabase/config.toml`) before the final commit below, and
both the dev server and `npx supabase stop` were shut down afterward.

**Authorized (owner) role** -- signed in as the seeded
`wbudiman1995@gmail.com` (owner, full permissions) and exercised
`/programs/memberships` end to end:

1. **Renewal preview loads automatically and shows readable terms, not raw
   IDs**: expanding a row auto-fetched the preview, showing package name,
   `row.serviceName ?? "semua layanan"`, pet name, session delta, price,
   current -> resulting balance, and current -> resulting expiry, plus a
   "Dimuat HH:MM:SS" timestamp.
2. **Submit is gated on a loaded, non-blocking preview and a bound
   fingerprint**: confirmed via `javascript_tool` that the hidden
   `termsFingerprint` input carried a real, non-empty md5 value
   (`333c63b3fc29ce1b2e661833b081523c`) before submit.
3. **Genuine renewal success**: selected a branch, submitted, got
   `Paket diperpanjang. PKR-20260926-F534D1AC diterbitkan.`; sessions went
   2/2 -> 3/3, expiry 14/1/2027 -> 14/5/2027, header now reads
   "diperpanjang 1x".
4. **Failure/disabled path after a successful renewal (real, not
   simulated)**: immediately after success the preview is cleared and the
   submit button's own label changes to "Muat pratinjau terlebih dahulu"
   or "Coba lagi" and is `disabled` -- a genuine retry cannot fire without
   a fresh preview, live in the browser, not just asserted against the
   source string.
5. **"Muat ulang pratinjau" refresh works**: clicking it re-fetched a fresh
   preview (new expiry math 14/5/2027 -> 11/9/2027) and re-enabled
   submission.
6. **Terms-correction form ("Koreksi data paket")**: opened it on the
   just-renewed row; empty-reason submit was blocked by the browser's own
   `required` validation ("Please fill out this field"); the scope-lock
   message ("Hewan dan layanan tidak dapat diubah karena paket ini pernah
   dipesan, dipakai, atau diperpanjang...") was shown and the pet/service
   selects were disabled because this package already had `renewal_count >
   0`; filled a reason and submitted an expiry-only correction, which
   succeeded (`Data paket berhasil dikoreksi.`).
7. **Reconciliation panel**: ran it on a legacy (no source-invoice) row;
   showed `Saldo cache: 3 | Saldo ledger: 3 | Cocok`, 0 active reservations,
   and correctly flagged `missing_source_invoice` under "Perlu peninjauan
   manual" for that legacy row -- not silently auto-repaired.

**A real bug was found and fixed during this verification, not just
simulated**: step 6 above initially reproduced a genuine defect --
`MembershipManager`'s "Koreksi data paket" form pre-fills its `Kedaluwarsa`
date input from the `row.expiresAt` prop via `useState`'s lazy initializer,
which only runs once per mount. Because a successful renewal does not
remount the row's component (only its raw text fields re-render from the
fresh prop), the correction form kept showing the **pre-renewal** expiry
date. Submitting that stale value as a "correction" silently reverted the
just-completed renewal's expiry extension back to its old value -- verified
directly against the database (`customer_packages.expires_at` went from
`2027-05-14` back to `2027-01-14` after such a submit, with no error, since
`update_customer_package_terms`'s own revision guard has nothing to catch
here: it is doing exactly what it was told). **Fix**:
[membership-filter-list.tsx](../../apps/web/src/components/membership-filter-list.tsx)
now keys each `<MembershipManager>` by
`` `${row.id}-${row.revision}-${row.renewalCount}-${row.expiresAt}-${row.petId}-${row.serviceId}` ``
instead of just `row.id`, so the row's entire local state (including the
correction form's pre-filled inputs) is freshly re-initialized from the
latest server data whenever any of those fields change server-side (a
renewal, a correction, a reservation). Re-tested live after the fix: a
second renewal on the same row, followed by immediately reopening "Koreksi
data paket" (no page reload), showed the **correct** post-renewal expiry
(`05/14/2027`), and submitting an unrelated expiry-only correction no longer
reverted anything. Re-ran `npm run typecheck`, `npm run lint -w apps/web`,
and `npm run test:batch1b -w apps/web` (283/283 pass) after this fix --
logs: `npm_typecheck_review3_browserfix.log`,
`npm_lint_review3_browserfix.log`, `npm_test_batch1b_review3_browserfix.log`.

(Note on process, for whoever debugs this class of issue again: the first
attempt at this fix appeared not to work when tested live, because the dev
server -- running inside WSL2, watching the repo over its `/mnt/e` 9p
mount -- did not pick up a file edit made from the Windows side via
filesystem watch/HMR. Restarting `npm run dev` picked up the change
immediately. This is an environment quirk of this sandbox, not a defect in
the fix or the app.)

**Read-only / unauthorized role**: no read-only-role user existed in the
seed data. Rather than fabricate one, the seeded `groomer@homepaw.local`
account was used, since its role (`Groomer`) holds only
`booking.read`/`booking.update`/`booking.complete` -- no `membership.read`
or `membership.manage`. Signed in as that account and navigated to
`/programs/memberships`: the page rendered its genuine empty state
("Belum ada paket pelanggan"), because `customer_packages` (and the other
membership tables) are RLS-gated on the `membership.read` permission
(registered in `20260721001100_security_rls_capabilities.sql`), which this
role does not hold. This confirms the authorization boundary is enforced at
the database (RLS) layer, not merely hidden in the UI -- an unauthorized
session cannot see membership administration data at all, not just fail to
mutate it.

**Genuine remaining gap, reported plainly rather than glossed over**: this
repo has no seeded role with `membership.read` but *without*
`membership.manage` (i.e. a true "can view, cannot edit" role), so the
specific UI behavior of `canManage=false` (read-only visible rows, hidden
mutation forms, but a visible reconciliation panel) was verified by earlier
static/contract tests and by code inspection, not by driving that exact
role through a live browser session -- only the two extremes (full owner
access, and zero access via RLS) were exercised live. Creating such a role
would require either a new seed fixture or an in-app staff/role-management
UI, neither of which exists yet in this worktree; flagging this rather than
claiming it was covered.

Screenshots were captured and visually reviewed at each step above through
the in-app browser tool during this session, but the tool does not persist
them to disk as files -- there is no PNG artifact path to attach here
beyond this written, step-by-step reproduction record.

### What Codex should verify next (review round 3)

1. **Independently confirm the `terms_fingerprint` design has no gap**: it
   is computed once under the row lock inside `renew_customer_package` (and
   separately, identically, inside the read-only `preview_package_renewal`,
   which does NOT hold the row lock). Between a preview and a submit, could
   a concurrent write change `cp`/`pkg` in a way NOT captured by the
   fingerprint's field list, yet still affect the charge? The fingerprint
   covers every field this session identified as charge-relevant; a second
   pair of eyes on that list specifically is worth having.
2. **Confirm the `entitlement_scope_locked_after_first_reservation` boundary
   (ANY reservation of ANY status, forever) is the right permanence
   choice** -- an alternative would be to only lock while a reservation is
   currently `'reserved'`/`'consumed'` and allow correction again once
   fully `'released'`/`'expired'`. This session chose the stricter,
   permanent-once-touched rule as the safer default; revisit if it proves
   too restrictive in practice.
3. **Re-run the full gate suite once more on a completely clean host** (this
   sandbox's docker-exec-in-container methodology is unchanged from round
   2, just re-run against the further-amended migration) as an independent
   confirmation outside this session's own tooling.

---

## Review round 2 (2026-09-26) — superseded by round 3 above

Codex reviewed commit `86ad714` (the "Follow-up completion" work described in the next section) and found 4 code-level findings despite the passing gate 7/8 logs already committed at that point. This section documents each finding and its fix; the "Follow-up completion" section below is otherwise still accurate (nothing in it was wrong, these findings are additional gaps that survived it) except where explicitly corrected here.

**All 4 findings from this round are fixed on this branch. One item from the original section 25 brief was left genuinely incomplete at the time (not disguised as done) — see "Remaining incomplete requirement" below — and was subsequently built in review round 3 (see the top of this file).**

### Finding 1 — upgrade migration fails when purchase ledger rows already exist (FIXED)

`20260926090000_membership_renewal_billing_and_reconciliation.sql` originally backfilled `customer_package_ledger.invoice_id` onto existing `'purchase'` rows with an `UPDATE`. `customer_package_ledger` is append-only (`trg_cpl_block_update`, from the very first customer-programs migration, unconditionally rejects any `UPDATE`). On a fresh, empty schema that `UPDATE` matches zero rows and the trigger body never runs, so gate replay against a fresh schema passed — but the same `UPDATE` raises `restrict_violation` the instant it runs against a database that already has one real purchase (i.e., any actual installation that has ever sold a package).

**Fix:** removed the backfill entirely. `invoice_id` is now set only at `INSERT` time (by `create_package_invoice`/`renew_customer_package` going forward); historical purchase provenance already lives on `customer_packages.source_invoice_id` (set by the *original* section 24 migration), so `reconcile_customer_package` reads that column directly for legacy rows instead of requiring a retrofitted ledger column. The migration was amended in place (not layered under a third migration) because it had never been applied outside disposable, destroyed-after-use test containers.

**New permanent regression test:** `integration/migration_upgrade_replay.sh` — applies every migration up through (but not including) `20260926090000_...`, creates a **real** purchase via the real `app.create_package_invoice` RPC (a real `customer_package_ledger` `'purchase'` row now exists), *then* applies `20260926090000_...` on top, and asserts it succeeds and the real row survived untouched. I additionally confirmed the ORIGINAL (buggy) `UPDATE` genuinely fails in exactly this scenario, by running it standalone against the same populated database: `ERROR: Updates blocked on customer_package_ledger (append-only/immutable). Insert a correcting row instead.` — proving the bug was real, not theoretical, before claiming the fix.

### Finding 2 — rollover configuration was ignored (FIXED)

`packages.rollover_policy` (`'none'|'rollover'`) is exposed as editable in the new catalog UI, but `renew_customer_package` always just added `pkg.total_sessions` on top of the existing balance regardless of the setting — a control that did nothing. (This column pre-dates this branch entirely, from the original `customer_programs` migration; it was never consumed anywhere in the codebase before this branch exposed it as editable without wiring it up.)

**Fix:** `renew_customer_package` now branches on `rollover_policy`. `'rollover'` (unchanged): adds `pkg.total_sessions`, nothing discarded. `'none'`: computes the currently-**held** (reserved) session count, discards only the **unreserved excess** above that via one explicit compensating `'adjustment'` ledger row (never a raw `UPDATE` to `sessions_remaining`), then adds `pkg.total_sessions`. Reserved sessions — which back a real, already-scheduled booking line — are never reduced or touched by either policy. Tested with a genuine positive remaining balance *and* an active held reservation on a `rollover_policy='none'` package (see S39-S41 below): the held session survives untouched, only the unreserved excess is discarded.

### Finding 3 — renewal retries depended on mutable catalog state; no preview (FIXED)

Two related bugs, both in the idempotent-retry check: it compared `v_invoice.total <> pkg.price`, where `pkg.price` is re-read fresh on every call. A legitimate retry (same `request_key`, same membership, same branch) after the catalog price changed in between was wrongly rejected as `request_key_reused_for_different_renewal` — the opposite of idempotent. Conversely, nothing validated that a catalog per-pet-scope change since the original sale hadn't made the renewal's terms incompatible with the entitlement it's topping up.

**Fix:**
- Removed the price comparison from the idempotency check entirely — price is server-derived state, not a caller input, so it should never gate idempotency. The check now compares only genuinely caller-supplied material inputs: the membership being renewed and the branch. A retry with the SAME key at a DIFFERENT branch is still correctly rejected (new test, S45).
- Added a hard guard: if `pkg.per_pet <> (cp.pet_id is not null)` (the catalog's current per-pet flag disagrees with whether this specific membership actually has a pet scope), renewal is refused with `catalog_terms_changed_incompatible_with_existing_entitlement` rather than silently charging for a now-different product against an old entitlement.
- Added `app.preview_package_renewal` (read-only, `membership.read`) returning price, currency, sessions to add, rollover policy, pet/service scope, current vs. resulting available sessions, current vs. resulting expiry, and the same incompatibility check/blocking reason — surfaced in the UI as soon as the "Kelola" panel opens, before the renewal form can be submitted (submit is disabled when the preview reports a blocking reason).

### Finding 4 — invoice reconciliation only checked for NULL linkage (FIXED)

The prior `reconcile_customer_package` treated any non-null `invoice_id` as sufficient proof of correct provenance — the FK only guarantees the invoice exists in the same organization, not that it's the *right* invoice.

**Fix, all in `reconcile_customer_package`:**
- A non-null `invoice_id` on a purchase/renewal ledger row is now validated against the actual invoice: same `customer_id`, a relevant status (`issued`/`paid`, not `void`), and at least one matching `invoice_lines` row for the same `package_id`. New `invalid_invoice_links` flag. Tested with a real, same-organization, wrong-**package** invoice deliberately attached to a renewal row (S52) — flagged, not silently accepted.
- `unlinked_purchase_or_renewal_invoice` narrowed to `unlinked_renewal_invoice`: only `'renewal'` rows are required to self-link via `invoice_id` now (every renewal since this migration sets it); `'purchase'` provenance is `customer_packages.source_invoice_id`, already covered by the separate `missing_source_invoice` flag (see finding #1's fix — there is no retrofitted ledger-level purchase link to check).
- New `missing_reversal_link`: a reservation that was consumed (has a `consumption_ledger_id`) but is no longer `status='consumed'` must have gone through `reverse_package_reservation`, which always sets `reversal_ledger_id` — a released-after-consumption row with no reversal link is a broken invariant. Tested (S53) by consuming a reservation and then releasing it directly (bypassing `reverse_package_reservation`).
- New `duplicate_consumption_links`: no DB uniqueness constraint prevents two `package_reservations` rows from pointing at the same `consumption_ledger_id`; now checked explicitly rather than assumed impossible. Tested (S54) by pointing a second reservation's link at the first's ledger row.

### Remaining incomplete requirement — guarded purchased-term editing (SUPERSEDED — implemented in review round 3, see the top of this file)

The original section 25 brief asked for "guarded editing of applicable purchased terms, with reason, audit, and revision checks." At the time this round-2 section was written, this branch deliberately implemented only the **stateful lifecycle actions** — renew, archive/reactivate, reconcile, repair — plus a read-only renewal preview and a full ledger/reservation history view, and NOT a field-by-field editor. **Review round 3 built it**: `app.update_customer_package_terms` (allow-list of `expires_at`/`pet_id`/`service_id`, revision-checked, reasoned, audited in `timeline_events`, locked once the entitlement has any reservation history or a renewal) plus a matching UI form. See "Review round 3" at the top of this file for the full design and its tests (S68-S76). This paragraph is kept for historical continuity, not as a current gap.

### Verification — review round 2, exact results

All commands re-run against the fully amended migration. Logs under `docs/handoffs/logs/S23-S26/` (absolute path: `E:\Claude\operro-review-s23-s26\docs\handoffs\logs\S23-S26\`).

| Command | Result | Log file |
|---|---|---|
| `npm run typecheck -w apps/web` | exit 0, clean | `npm_typecheck_review2.log` |
| `npm run lint -w apps/web` | exit 0, clean (caught and fixed one real issue: a `useState` setter referenced before its declaration in a hook body — a hard error, not a style nit, under this repo's `react-hooks/immutability` rule) | `npm_lint_review2.log` |
| `npm run test:batch1a -w apps/web` | **107/107 pass** | `npm_test_batch1a_review2.log` |
| `npm run test:batch1b -w apps/web` | **272/272 pass** (up from 265; contract suite extended to cover all 4 findings plus the incomplete-item disclosure) | `npm_test_batch1b_review2.log` |
| `npm run build -w apps/web` | exit 0 — 31 routes | `npm_build_review2.log` |
| PostgreSQL 16 — GATE 4-6 + both SQL smoke tests | **all pass**, 91 `PASS` notices total, zero errors | `pg16_migration_gate4_6_smoke_review2.log` |
| PostgreSQL 16 — GATE 7 (real authenticated-role integration, literal script) | **PASSED** | `pg16_gate7_gate8_review2.log` |
| PostgreSQL 16 — GATE 8 (concurrency harness, literal script) | **PASSED** | `pg16_gate7_gate8_review2.log` |
| PostgreSQL 16 — `integration/migration_upgrade_replay.sh` (NEW, finding #1's permanent regression test) | **PASSED** — real purchase row survives an upgrade that would previously have failed | `pg16_migration_upgrade_replay.log` |

`integration/package_lifecycle_smoke.sql` grew from 38 to **54** assertions (S1-S54); the 16 new ones (S39-S54) cover: rollover_policy='none' protecting a held session while discarding unreserved excess, a legitimate retry after a catalog price change, a request_key reused at a different branch, `preview_package_renewal`'s no-write guarantee and field set, the per_pet-drift incompatibility guard (both in preview and at the actual write), a real wrong-package invoice attached to a renewal row (`invalid_invoice_links`), a consumed-then-released-without-reversal reservation (`missing_reversal_link`), and two reservations sharing one consumption ledger row (`duplicate_consumption_links`).

**Browser verification: not performed this round** (recorded separately from compilation/SQL evidence, per instruction) — this round's changes are entirely server-side RPC logic plus one new client-state ordering fix caught by lint; the new UI surface (renewal preview panel, disabled-submit-on-incompatibility) was exercised only via the contract test's static assertions and the SQL-level behavior tests, not a live browser session. If a visual/interaction check of the preview panel is wanted, that is still open.

### What Codex should verify next (review round 2)

1. **Independently confirm the `invalid_invoice_links` join logic has no false positives for a healthy, real invoice** — the check requires `invoice_lines.item_type='package' and package_id=cp.package_id`; if any future code path creates a package invoice line without `item_type='package'` set correctly, this would misfire. Worth a second look against `create_package_invoice`'s and `renew_customer_package`'s own inserts (both already set it correctly, but it's the single coupling point).
2. **Reconsider whether `rollover_policy='none'`'s discard-on-renewal is the product behavior actually wanted** — this session implemented the mathematically-safe interpretation (protect held sessions, discard only unreserved excess), but the original HomePaw reference material for this exact policy was not available to check against (see the original follow-up section's risk #4 about missing HTML references).
3. ~~Decide whether to build the guarded purchased-term editor~~ — **built in review round 3** (see the top of this file).

---

## Follow-up completion (2026-09-26) — see "Review round 2" above for what changed after this

This follow-up closes every gap the Codex review found in the `9279f56` state (branch/commit history below). **All four sections (23-26) are now functionally complete, tested, and pushed.** Nothing was merged, deployed, or applied to a shared/real Supabase project — this remains an isolated branch.

### What changed in this follow-up, section by section

**Section 23 (coverage detection).** Fixed a real bug: the booking wizard's over-allocation warning excluded the *entire current pet* from its "other allocations" count, so selecting the same package for two different services on the SAME pet was never flagged, even though the server would still correctly reject the second reservation under lock. Fixed to count every other `(pet, service)` cell, including a different service on the same pet ([booking-wizard.tsx](../../apps/web/src/components/booking-wizard.tsx)). Re-verified the final-session race with a genuine two-connection test (see PostgreSQL 16 section).

**Section 24 (packages and memberships) — the two biggest gaps, both closed:**
1. **Paid renewal is now a real commercial transaction.** `app.renew_customer_package` (dropped and recreated; new signature, new return type) now creates an order, invoice, and invoice line — exactly like the original sale in `create_package_invoice` — instead of silently granting sessions. Branch is a **required** argument; the UI defaults it to the source invoice's branch when known but the staff member confirms/can change it (never silently guessed, and a legacy membership with no source invoice forces an explicit choice). See "Renewal billing policy" below for the exact rules.
2. **Package catalog terms are now configurable in the app.** `/programs` gained a catalog editor (recurrence interval, per-pet flag, session count, price, validity days, rollover policy, applicable service, active flag) via `createPackageAction`/`updatePackageAction` — plain RLS-guarded table writes on `public.packages` (the same pattern already used by `createServiceAction`/`updateServiceAction`), gated on the pre-existing `membership.manage` capability. Editing the catalog can only ever change future sales; it structurally cannot rewrite an already-sold `customer_packages` row (verified by a contract test that greps `updatePackageAction`'s body for the absence of any `customer_packages` reference).

**Section 25 (membership administration).** The renewal form now has an explicit branch selector + invoice date/due-date fields and reports the issued invoice number. Added a per-membership, lazy-loaded history panel (ledger rows with their linked invoice number, and the reservation lifecycle) via `loadMembershipHistoryAction` — scoped to one `customer_package_id`, never an unbounded organization-wide query. Urgency now also reacts to an exhausted balance (0 available sessions), not only to the expiry date, fixing a real gap where a package with no sessions left but a far-off expiry showed as "normal." Legacy memberships (no `source_invoice_id`) are flagged in the UI.

**Section 26 (subscription reconciliation).** `app.reconcile_customer_package` is rewritten to verify actual **links**, not counts: every `consumed` reservation's `consumption_ledger_id` must point to a real matching ledger row; every reversed reservation's `reversal_ledger_id` likewise; an orphan consumption ledger row (one no reservation links back to) is now detected even though the raw counts alone would look fine. It also flags unlinked purchase/renewal invoices, over-reservation, expiry/status inconsistency, and missing source-invoice provenance — all under a `manual_review_issues` array, explicitly separate from `auto_repairable` (cache-vs-ledger drift, the *only* thing the guarded repair RPC ever touches). `repair_customer_package_balance` itself is **unchanged** — it never invents financial history, exactly as instructed.

**Security/error-prone areas, explicitly re-tested this session** (see the extended SQL smoke test for the actual assertions): two organizations; a same-organization **read-only** member (`membership.read` only) calling every write RPC directly (bypassing the UI) and being denied, including a retry of an **already-used renewal request_key** — authorization is re-checked on every call, so a caller without `membership.manage` never receives the cached idempotent result of someone else's earlier successful call; a request_key reused for a *different* membership is rejected; cross-organization denial for reconcile/repair/renew; RLS-as-`authenticated`-role visibility across two real organizations; a genuine two-connection race for the final available session (exactly one winner, the other correctly rejected, never two reserved rows).

### Renewal billing/activation/rollover/expiry policy (explicit, uniform across every status)

- **Sessions always roll over.** A renewal is `+package.total_sessions` appended to `customer_package_ledger` (reason `'renewal'`) on top of whatever balance already exists — there is no "reset to catalog total" path and no per-status branching (active, exhausted, and expired packages all behave identically).
- **Expiry always extends from `greatest(now(), current expires_at)`.** An active package loses no remaining paid-for time; an already-expired package's new term starts counting from today. Same formula for every status.
- **The invoice is always created, even for a zero-price package.** An invoice with `status = 'issued'` is a billing record, not proof of payment — this RPC never marks anything paid; payment is the pre-existing, separate `payments` table/flow.
- **Branch is mandatory and explicit**, never inferred silently. The UI pre-fills the source invoice's branch when one exists; a legacy membership with no source invoice has no pre-fill and forces the staff member to pick one.
- **Canceled memberships cannot be renewed**; an inactive catalog package cannot be used to renew either (its terms are no longer sold).
- **No automatic card charging, no scheduler, no recurring-billing infrastructure** was added — this remains a manual, staff-initiated action, per the original constraint.
- Idempotency: locks the `customer_packages` row first (serializing concurrent retries), then re-authorizes (`membership.manage` + `invoice.issue` + `finance`/`membership` modules + branch access), then checks `public.invoices` for the `request_key` — if found, validates it is the SAME membership/branch/price before returning it (else `request_key_reused_for_different_renewal`), otherwise proceeds. A double-click, timeout-retry, or concurrent identical request produces exactly one invoice and one renewal ledger row.

### Branch / commits (this follow-up)

- Base for this follow-up: `claude/sections-23-26-memberships` at `5b486266ad317d0a698110f41b97ca5278e063ff` (the Codex-reviewed state; see that section below for its own history back to `f820b6b`).
- New migration: `supabase/migrations/20260926090000_membership_renewal_billing_and_reconciliation.sql` (forward-only; does not edit `20260925100000_package_membership_lifecycle.sql` or any earlier migration).
- Nothing pushed to any shared/real Supabase project; only this isolated branch was pushed to `origin` at the end of this session (final SHA reported in the chat reply, not repeated here to avoid drift if this file is read out of order).

### Files changed in this follow-up

**Migration**
- `supabase/migrations/20260926090000_membership_renewal_billing_and_reconciliation.sql` (new) — `customer_package_ledger.invoice_id` column + FK + backfill; `create_package_invoice` now stamps `invoice_id` on the purchase ledger row (`create or replace`, same signature); `renew_customer_package` **dropped and recreated** with a new signature/return type (real invoice creation); `reconcile_customer_package` **rewritten** (deep link verification, `auto_repairable`/`manual_review_issues`).

**App code**
- `apps/web/src/components/booking-wizard.tsx` — fixed the same-pet multi-service over-allocation undercount.
- `apps/web/src/app/pilot-actions.ts` — `renewCustomerPackageAction` rewritten (branch/dates, issues an invoice); new `createPackageAction`/`updatePackageAction` (catalog CRUD); new `loadMembershipHistoryAction`; `PackageReconciliationReport` extended with `autoRepairable`/`manualReviewIssues`.
- `apps/web/src/components/pilot-forms.tsx` — new `PackageForm` (catalog create).
- `apps/web/src/components/package-manager.tsx` (new) — catalog edit form (mirrors `service-manager.tsx`).
- `apps/web/src/lib/pilot-data.ts` — `CatalogWorkspace.packages` extended with the full catalog term set.
- `apps/web/src/app/programs/page.tsx` — wires the new catalog form/editor in place of the old static read-only list.
- `apps/web/src/lib/membership-admin.ts` — `loadMembershipAdministrationWorkspace` now also returns `branches` and each row's `sourceInvoiceBranchId`/`isLegacy`; urgency computation unchanged from the prior session's fix (exhausted balance also counts as urgent).
- `apps/web/src/components/membership-manager.tsx` — renewal form gains branch/date fields; new lazy-loaded history panel; reconciliation panel shows `manualReviewIssues` separately from the (now `autoRepairable`-gated) repair button.
- `apps/web/src/components/membership-filter-list.tsx`, `apps/web/src/app/programs/memberships/page.tsx` — thread `branches` through.

**Tests**
- `apps/web/test/package-lifecycle-contract.test.ts` — rewritten: the two RPC-name-distance regexes that broke twice now (see "the flaky test, corrected" below) use two independent, distance-free assertions instead of one `{0,N}`-bounded window; extended with contract tests for the new renewal/reconcile/catalog behavior.
- `integration/package_lifecycle_smoke.sql` — extended from 22 to **38** assertions (S1-S38): the new invoice-creating renewal (S12-S21), a request_key reused for a different membership (S22), the deep-reconcile link checks including an induced orphan consumption ledger row and a legacy no-source-invoice package (S23-S27), a cross-org renewal denial even with the caller's own valid branch (S32), and — new — a same-organization read-only member denied renew/repair/archive but allowed to preview reconcile, including a denied retry of an already-used request_key (S35-S38).

**Docs**
- `docs/HOMEPAW_PARITY_PLAN.md` — sections 23-26 all moved to "Done" with accurate, specific notes.

### The flaky test, corrected

The *original* handoff (before Codex's review) attributed one `test:batch1b` failure to "resource contention" without being able to reproduce it. This follow-up found the real, deterministic cause: `package-lifecycle-contract.test.ts` had a regex of the form `/renewCustomerPackageAction[\s\S]{0,N}rpc\("renew_customer_package"/` — a fixed character budget between two anchors. Codex's review already had to widen this once (300→600) after adding an authorization check; this session's changes (branch/date parsing) pushed it over budget *again*. This was never flakiness — it was a brittle regex that breaks every time unrelated, legitimate code grows between its two anchors. Fixed properly this time: replaced with a helper (`assertFunctionCallsRpc`) that finds the named function's body by locating the *next* function declaration (no fixed distance at all) and asserts the RPC call within that boundary. Per the instruction to favor real behavior tests over regex text-matching, the bulk of new verification for this follow-up went into the SQL integration smoke test, not new regex assertions.

### Test commands, exit codes, and raw logs (this follow-up, final combined branch)

All log files are under `docs/handoffs/logs/S23-S26/` (absolute path on this machine: `E:\Claude\operro-review-s23-s26\docs\handoffs\logs\S23-S26\`).

| Command | Result | Log file |
|---|---|---|
| `npm run typecheck -w apps/web` | exit 0, clean | `npm_typecheck_followup.log` |
| `npm run lint -w apps/web` | exit 0, clean | `npm_lint_followup.log` |
| `npm run test:batch1a -w apps/web` | **107/107 pass** | `npm_test_batch1a_followup.log` |
| `npm run test:batch1b -w apps/web` | **265/265 pass** (0 failures — the flaky #211 from before is fixed, not just re-passed) | `npm_test_batch1b_followup.log` |
| `npm run build -w apps/web` | exit 0 — 31 routes | `npm_build_followup.log` |

### PostgreSQL 16 — GATE 7 and GATE 8 now genuinely ran as literally scripted

**The environment blocker from the prior session is resolved.** The prior session's substitute was necessary because WSL2's mirrored networking makes `127.0.0.1:<published-port>` unreachable *from the host* to a Dockerized Postgres. The fix this session: run the SQL client **inside the container** via `docker exec` (where `127.0.0.1` is the container's own loopback and genuinely reachable), instead of connecting from the host. Concretely: `docker cp` the `supabase/tests/concurrency/` harness into the container (stripping the Windows checkout's CRLF line endings, which otherwise corrupt the bash script's `set -o pipefail`/`trap` lines), then `docker exec` runs `bash run_concurrency_assembly.sh` with `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/operro_cc` — no bind mount needed for the SQL-only steps (those are piped over `docker exec -i psql < file` from the host, which works fine since only stdin/stdout cross the boundary, not a TCP connection).

1. **Full 43-migration lineage** (42 prior + this follow-up's new one) replayed clean on a disposable `operro_gate16_v2` database.
2. **GATE 4**: `assembly%` function count = 8 (unchanged).
3. **GATE 5 / GATE 6** (unmodified existing suites): all PASS.
4. **`integration/invoice_parity_smoke.sql`** (the orphaned section 20-22 carry-forward test, run this time with its required `0100_integration_seed.sql` prerequisite): both assertions PASS — package invoice idempotency/line/balance, and the discounted-visit preview-vs-issued-total agreement.
5. **`integration/package_lifecycle_smoke.sql`**, extended to 38 assertions: **all PASS** (see the file itself for S1-S38; summarized above).
6. **GATE 7** (`integration/0100_integration_seed.sql` + `0100_integration_client.sql`, run as the literal `operro_gate_client` authenticated-role login, exactly as `run_all_gates.sh` scripts it): **PASSED**.
7. **GATE 8** (`supabase/tests/concurrency/run_concurrency_assembly.sh`, exactly as scripted — `complete_booking` vs `set_line_quantity`/`void_line`/`reserve_package_session`): **PASSED** — all three cases: no deadlock, session A committed, session B genuinely blocked then received the correct frozen-booking rejection.
8. **New: a standalone two-connection race for the FINAL available session** of a 1-session package (not GATE 8's booking-freeze scenario — a direct reservation-vs-reservation race): session A reserves the only session and holds the row lock for 3s before committing; session B, started 1s later, genuinely blocks and then correctly fails with `no_sessions_available` after A commits. Final reserved-row count: exactly 1, never 2.

Raw logs: `pg16_migration_gate4_6_smoke_followup.log` (items 1-5), `pg16_gate7_gate8_followup.log` (items 6-7), `pg16_final_session_race_followup.log` (item 8). The prior session's logs (`npm_typecheck.log`, `npm_lint.log`, `npm_test_batch1a.log`, `npm_test_batch1b.log`, `npm_build.log`, `pg16_concurrency_race.log`, `pg16_migration_gate5_gate6_smoke.log`) remain in the same folder as historical record of the pre-review state; the `_followup` files are the current, authoritative ones.

**What was NOT run as one literal top-to-bottom `bash run_all_gates.sh` invocation:** the script assumes a native `psql`/`createdb`/`dropdb` reachable via host-to-container TCP, which this sandbox's WSL2 mirrored-networking mode still does not support (unchanged limitation). GATE 1-3 (node/npm-based: typecheck, workspace build, in-memory tests) were run directly via WSL/npm, not inside the container (no Node.js in the `postgres:16` image, and installing it there would add risk for no verification benefit). GATE 4-8 ran their **exact, unmodified** SQL/bash scenarios inside the container, which is what item 2 in the original follow-up brief accepted as sufficient ("running the client/harness inside a suitable container is acceptable, but document the exact commands and environment" — done above).

### Unresolved risks / scope decisions (this follow-up)

1. **Membership administration's history view is read-only and does not paginate.** For a membership with an unusually large ledger/reservation history this could be a large single query; scoped to one `customer_package_id` (never organization-wide), so the practical size is bounded by how many times that one membership has been renewed/consumed, which is small in practice. Flagged, not fixed, since nothing in this task described an expected volume.
2. **`repair_customer_package_balance` is unchanged and was not re-audited this session** beyond confirming (via the contract test) that the follow-up migration does not redefine it. Its own correctness was independently reviewed in the prior Codex pass.
3. **The catalog write path (`createPackageAction`/`updatePackageAction`) has no dedicated negative RLS test in the SQL smoke test** — it relies on the pre-existing, unmodified `packages_write_ins`/`_upd`/`_del` restrictive policies (from `20260721001100_security_rls_capabilities.sql`, unchanged by this branch) plus the JS contract test's assertion that the server action checks `membership.manage` before writing. This is a narrower proof than a live RLS denial test would be; reasonable given the RLS mechanism itself is pre-existing and shared by a dozen other tables already exercised elsewhere in this repo's test suite, not something this branch changes.
4. **`integration/invoice_parity_smoke.sql` is still not wired into `run_all_gates.sh`** as its own gate step (same as noted in the prior session) — it was run manually this session (see above) and passes, but remains orphaned from the automated script. Recommended follow-up, not done here to stay focused on sections 23-26.
5. **`integration/package_lifecycle_smoke.sql` is likewise still not wired into `run_all_gates.sh`.** Same recommendation as before.
6. **The GATE 7/8-inside-container methodology is not itself committed as a script** — the exact commands are documented above and are reproducible by any operator with docker + WSL2 (or any Linux host, where the whole problem disappears). Not added as a permanent script in this branch since it is sandbox-specific plumbing, not portable CI infrastructure; `run_all_gates.sh` itself is unchanged apart from the `EXPECTED_MIGRATIONS` lineage entry for the new migration.

### What Codex should verify next

1. **Independently re-derive the renewal idempotency-comparison logic** in `app.renew_customer_package` (`v_invoice.branch_id <> p_branch or v_invoice.metadata->>'renewal_of' is distinct from cp.id::text or v_invoice.total <> pkg.price`) — confirm these three fields are sufficient to catch every "material input changed" case the brief asked for (membership, branch, price), and that comparing against `pkg.price` *at retry time* (not the price captured on the original invoice) is the intended semantics if the catalog price changes between the original call and a retry within the same short idempotency window.
2. **Confirm the deep-reconciliation link checks have no false positives on a real, larger dataset** — this session's proof uses a small, hand-built fixture per issue; a real Supabase project's actual historical data (especially pre-this-branch legacy rows) may surface edge cases the fixture didn't anticipate (e.g., a `consumption` ledger row from before `reference_line_id`/`consumption_ledger_id` existed at all — check the migration history for when those columns were added relative to any real production data, if this is ever pointed at a non-empty database).
3. **Re-run GATE 7/GATE 8 on a host where native TCP to Postgres actually works** (this sandbox's container-exec substitution is a faithful re-creation of the same scenarios, but a completely clean-room run outside any workaround is still worth one confirmation).
4. **Review whether the package catalog UI needs a confirmation step before deactivating (`isActive=false`) a package that customers currently hold active memberships of** — deactivating only blocks *future* sales and renewals (an inactive package cannot be renewed, per policy above); existing memberships keep consuming/reserving normally. This is intentional but worth a product-level second look.
5. **Confirm the invoice line name suffix `" (Perpanjangan #N)"` on a renewal invoice line doesn't collide with any downstream invoice-PDF/branded-document generation** (section 27, not yet built) that might parse `name_snapshot` expecting only the bare package name.

---

## Codex review addendum (2026-09-26)

**This section, and everything below it in this file, documents the state BEFORE the follow-up above.** It is kept for historical continuity (it explains what Codex found and fixed, and the original session's own PostgreSQL 16 proof) but its "Do not mark sections 24-26 complete" conclusion is superseded by the follow-up section at the top of this file.

This addendum supersedes the original session-status claims below. Claude later pushed `claude/sections-23-26-memberships` at `9279f56`; it is still isolated from `local/design-adoption`, with no PR, production deployment, or shared Supabase migration. The combined branch contains **42** migration files, not 41 (the base already had 41).

Independent review found and fixed: renewal/repair idempotency checks occurring before authorization and row locking; reused package-sale keys returning an invoice for different inputs; expired/canceled credits displayed as available in Customer 360; missing per-pet selection in the package invoice studio; and submit-time request-key rotation that weakened retry idempotency. The booking wizard does **not** call the new coverage RPC: it computes coverage from two tenant-scoped bulk queries. `/programs/memberships` displays a cached balance and reservation count; its normal list is not a full ledger-derived history. See the follow-up commit on this branch for the exact diff.

Review validation: typecheck exit 0; lint exit 0; batch1b 257/257; production Next build exit 0 with 31 routes; all 42 migrations applied on a disposable PostgreSQL 17 database; `integration/package_lifecycle_smoke.sql` passed all 22 assertions after the fixes. Claude's PostgreSQL 16 raw logs remain below as evidence of the original branch, not of this follow-up SQL diff. Full GATE 7/8 replay and PostgreSQL 16 replay of the follow-up diff remain outstanding.

**Do not mark sections 24-26 complete or deploy this branch yet.** Paid package renewal currently grants new sessions without a renewal invoice or payment flow. The package catalog has no UI to configure recurrence/per-pet terms. Administration has no purchased-term editor or full ledger history; reconciliation does not compare source/renewal invoices and all ledger lifecycle invariants. `docs/HOMEPAW_PARITY_PLAN.md` now states these limits explicitly.

## Branch / commits

- Base branch: `local/design-adoption`
- Base commit (verified before editing): `f820b6b904cffd9d7a24af7e395b8effc327fc06` ("Integrate invoice workflow, size pricing and discounts" — combines sections 20-22)
- Work branch: `claude/sections-23-26-memberships`
- Commits on this branch (original + review, before this follow-up):
  1. `1bd9837` — "Add HomePaw parity sections 23-26: package/membership lifecycle" (all code/migration/test changes)
  2. `4de7a91` — handoff doc + raw verification logs
  3. `9279f56` — urgency fix (exhausted sessions flagged regardless of expiry)
  4. `5b48626` — Codex review: security/idempotency fixes described above
- **Nothing has been pushed, deployed, or applied to any shared/real Supabase project** through any of these commits. All database verification ran against disposable, local-only Docker containers.

## Gap map (what existed before this branch)

| Area | Before | Gap this branch closes |
|---|---|---|
| Coverage detection | `app.fn_package_available_sessions`/`app.package_available_sessions` correctly subtracted reservations, but the booking wizard (`apps/web/src/lib/bookings.ts`) and Customer 360 (`apps/web/src/lib/customer-360.ts`) both queried the raw `sessions_remaining` cache directly, bypassing that math. No per-pet eligibility existed anywhere. | Batched coverage RPC + real UI (available/reserved split, over-allocation warning); per-pet eligibility enforced in `reserve_package_session`. |
| Packages and memberships | `packages`/`customer_packages`/`customer_package_ledger`/`package_reservations` existed with a working sell → invoice → ledger flow (`app.create_package_invoice`, section 20-22 work). No recurrence concept on packages (only `membership_plans.billing_interval`, a *different*, unrelated table). `source_invoice_id` was metadata-only (`metadata->>'source_invoice_id'`), not a real column. No renewal path at all. A second, dead, ledger-bypassing sale path (`sellPackageAction`/`PackageSaleForm`) was still in the tree, unreferenced by any page. | Real `recurrence_interval`/`per_pet` columns on `packages`; real `source_invoice_id`/`pet_id`/`activated_at`/`renewed_at`/`renewal_count` on `customer_packages`; manual, ledger-backed `app.renew_customer_package`; dead sale path removed. |
| Membership administration | `/programs` was read-only (catalog + customer balances list). No filters, no renew/archive, no detail view. | `/programs/memberships`: status/urgency filters, ledger-derived detail, guarded renew/archive, links back to Customer 360. |
| Subscription reconciliation | Did not exist. | `app.reconcile_customer_package` (read-only preview) + `app.repair_customer_package_balance` (separately authorized, revision-guarded, idempotent, audited write) + matching UI. |

## Migration: `20260925100000_package_membership_lifecycle.sql` (original)

Forward-only, additive, no prior migration edited. Every new column is nullable or has a safe default; every existing row and every existing RPC caller keeps working unchanged with the new arguments/columns left at their defaults.

**Schema changes**
- `customer_package_ledger`: `+request_key uuid` (unique per org, partial index `where request_key is not null`); `reason` check widened to add `'renewal'` (was `purchase|consumption|adjustment|expiry|refund`).
- `packages`: `+recurrence_interval text not null default 'none'` (`none|week|month|year`); `+per_pet boolean not null default false`.
- `customer_packages`: `+source_invoice_id uuid` (real FK to `invoices`); `+pet_id uuid` (FK to `pets`, null = any pet); `+activated_at timestamptz`; `+renewed_at timestamptz`; `+renewal_count integer not null default 0`; `+revision integer not null default 1`.
- Indexes: `idx_customer_packages_source_invoice`, `idx_customer_packages_pet` (both partial, `where ... is not null`).

**RPC signatures (as of this migration; renew_customer_package and reconcile_customer_package are SUPERSEDED by the follow-up migration above)**

```sql
app.reserve_package_session(p_line uuid, p_customer_package uuid, p_expires_at timestamptz default null) returns uuid

app.create_package_invoice(p_branch uuid, p_customer uuid, p_package uuid, p_issued_at timestamptz,
  p_due_at timestamptz, p_admin_notes text, p_request_key uuid, p_pet uuid default null) returns invoices

app.list_customer_package_coverage(p_customer uuid)
  returns table(customer_package_id uuid, package_id uuid, package_name text, service_id uuid, pet_id uuid,
                sessions_remaining integer, reserved_sessions integer, available_sessions integer,
                expires_at timestamptz, status text)

app.set_customer_package_status(p_customer_package uuid, p_status text, p_reason text default null) returns customer_packages

app.repair_customer_package_balance(p_customer_package uuid, p_revision integer, p_request_key uuid) returns customer_packages
```

## Migration: `20260926090000_membership_renewal_billing_and_reconciliation.sql` (this follow-up)

```sql
-- customer_package_ledger gains invoice_id (nullable, FK to invoices), backfilled
-- for existing 'purchase' rows from customer_packages.source_invoice_id.

-- create_package_invoice: create-or-replace, SAME signature, now also stamps
-- invoice_id on the purchase ledger row it inserts.

-- renew_customer_package: DROPPED + RECREATED (signature and return type both
-- change -- this is the bug fix, not a compatible extension).
drop function if exists app.renew_customer_package(uuid, uuid);
create function app.renew_customer_package(
  p_customer_package uuid, p_branch uuid, p_issued_at timestamptz, p_due_at timestamptz,
  p_admin_notes text, p_request_key uuid)
returns public.invoices

-- reconcile_customer_package: create-or-replace, SAME signature (p_customer_package
-- uuid) returns jsonb, extended output fields: auto_repairable boolean,
-- manual_review_issues jsonb (array of issue-code strings), plus the new
-- invalid_consumption_links / invalid_reversal_links / orphan_consumption_ledger_entries
-- / unlinked_purchase_or_renewal_invoice_entries / missing_source_invoice /
-- over_reserved / expired_but_status_active fields backing that array.
```

## UI routes and click paths (current, after this follow-up)

- **`/programs`** — "Katalog paket" now has a create form (if `membership.manage`) and each package row is editable (recurrence/per-pet/sessions/price/validity/service/active). Existing "Jual paket dengan invoice" and "Administrasi paket pelanggan" cards unchanged.
- **`/programs/memberships`** — filter by urgency chip or search → click "Kelola" to expand a row → renewal form now asks for **branch** (defaulted to the source invoice's branch when known) + invoice date/due date, then "Perpanjang & terbitkan invoice" → shows the issued invoice number on success. "Riwayat" button lazy-loads the ledger + reservation history. "Rekonsiliasi" shows cached vs. ledger balance, reservation/consumption link health, and — when present — a "Perlu peninjauan manual" list of issues distinct from the repair button (which now only appears when `autoRepairable`).
- **`/invoices/new`** (Invoice Studio) — unchanged from the Codex review: per-pet package selection when the chosen package is `per_pet`.
- **`/bookings`** (booking wizard) — unchanged UI, corrected same-pet-multi-service over-allocation count.
- **`/customers/[customerId]`** — unchanged from the Codex review (available/reserved split, pet name, no stale expired-credit display).

## Test commands, exit codes, and raw logs (original session, before Codex review and before this follow-up)

| Command | Result | Log file |
|---|---|---|
| `npm run typecheck -w apps/web` | exit 0, clean | `npm_typecheck.log` |
| `npm run lint -w apps/web` | exit 0 — 0 errors, 1 warning (pre-existing, unrelated) | `npm_lint.log` |
| `npm run test:batch1a -w apps/web` | 107/107 pass | `npm_test_batch1a.log` |
| `npm run test:batch1b -w apps/web` | 257/257 pass (see the corrected explanation above — this session found and fixed the actual cause) | `npm_test_batch1b.log` |
| `npm run build -w apps/web` | exit 0 — 31 routes | `npm_build.log` |

### PostgreSQL 16 — the original session's database proof (superseded by the follow-up section at the top for GATE 7/8; GATE 4-6 methodology unchanged)

Original environment note and GATE 1-6 proof preserved for continuity: this sandbox has no native `psql` installable via `sudo apt`, and WSL2's mirrored networking mode makes `localhost:<published-port>` unreachable from the host for a Dockerized Postgres. Every command in the original session ran via `docker exec` directly against a disposable `postgres:16` container (`operro_pg16_gate`). GATE 7/8 were **not** run end-to-end in the original session (see the follow-up section at the top of this file for their resolution).

## Unresolved risks / scope decisions (original session + Codex review; see the follow-up section at the top for what remains after this session)

1. ~~GATE 7 and GATE 8 (as scripted) were not re-run~~ — **resolved this follow-up**, see above.
2. Membership administration "edit" remains narrow by design: renew/archive/reactivate/reconcile/repair, plus (new this follow-up) a full history view — no free-form editing of a purchased package's raw fields by hand. Deliberate, to avoid a second way to mutate the same data outside the ledger.
3. ~~Renewal does not create a new invoice~~ — **fixed this follow-up**, see above.
4. The cited HomePaw HTML references (`index (2).html`, `booking (1).html`, etc.) were confirmed absent from this machine in an earlier session; sections 23-26 (and this follow-up) were implemented from the parity plan's descriptions and the user's own detailed task briefs, not the original HomePaw markup. A later session did paste an updated `index (3).html` reference for a *different*, already-merged piece of work (section 25's urgency logic); it was not needed for this follow-up.
5. The concurrency proof is a one-off script, not a permanent gate (unchanged recommendation — see "Unresolved risks" in the follow-up section at the top, item 6).
6. `integration/invoice_parity_smoke.sql` is still not wired into `run_all_gates.sh` (unchanged; run manually and passing, see above).
7. The originally-reported "flaky" `test:batch1b` run is now understood and fixed, not just unreproduced — see "The flaky test, corrected" in the follow-up section at the top.
