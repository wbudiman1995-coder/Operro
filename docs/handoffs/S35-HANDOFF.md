# Handoff: Section 35 — Retention and renewal

## Status

**In progress.** This file is being kept current as milestones land, per the
S35 brief's instruction to checkpoint continuously rather than leave only
chat claims. See "Checklist" below for exact state.

Baseline SHA (branch point): `bbdffb9eb3563fe5f4c884c5cf186c05522d41aa`
(sections 23-26 Codex closeout, branch `claude/sections-23-26-memberships`).
Worktree: `E:\Claude\operro-retention-s35`. Branch:
`claude/section-35-retention-renewal`.

## Requirement-to-existing-code map

| Requirement | Reused from | Notes |
|---|---|---|
| Renewal preview/pricing/fingerprint | `app.preview_package_renewal`, `previewPackageRenewalAction` | Already gated on `membership.read` only (verified by reading the RPC body) -- no weakening needed, a read-only role can already price a renewal. |
| Renewal mutation | `app.renew_customer_package`, `renewCustomerPackageAction`, `MembershipManager` | Gated on `invoice.issue` + `membership.manage`. Reused unmodified; deep-linked via a new `focusMembershipId` prop, not forked. |
| Membership row shape / mutable-field remount key | `apps/web/src/lib/membership-admin.ts`, `membership-filter-list.tsx` | Preserved; extended with fields needed for the renewal queue (recurrence_interval, ledger-derived held/consumed). |
| Correction form date semantics | `apps/web/src/lib/membership-correction.ts`, `timezone.ts` | Reused as-is; not modified. |
| Calendar-day math in business timezone | `zonedDaysBetween`, `zonedDayISO` (`timezone.ts`) | Reused directly in TS; SQL side uses the equivalent `(x at time zone 'Asia/Jakarta')::date` subtraction so both layers agree (documented in migration comments). |
| WhatsApp link + encoding | `buildWhatsAppUrl` (`customer-360.tsx`) | Reused unmodified -- already handles 0/62/+62/international/malformed correctly. |
| Org-level settings storage | `organizations.settings` jsonb (no dedicated settings table exists) | New `followup_retention` sub-key added via safe `jsonb ||` merge (never a blind full-object replace), so branding/other future keys are untouched. |
| Settings write permission | `settings.manage` (already seeded; already used for `organizations_write` RLS) | Reused; added to `CAPABILITY_KEYS` in `authorization.ts` (was missing from the TS-side allow-list even though the DB permission existed). |
| Audit trail for settings writes | `app.tg_write_audit` / `app.audit_log` | `organizations` never had this trigger attached (deliberately, per its own comment, since it lacks `organization_id`). The trigger already falls back to `app.fn_active_organization()` when that column is absent, so attaching it is safe reuse, not new machinery. |
| Tenant/branch authorization | `app.assert_tenant_authorized`, `app.has_branch` | Reused inside the two new RPCs; no bypass. |
| Last-groomed source of truth | `grooming_job_pets` (status), `bookings` (timing) per `pilot-data.ts`'s own comment that this join is intentional | Fixed the real bug: the old loader required `bookings.status = 'completed'` (whole booking), which hides a pet that is individually `complete` while a sibling pet on the same booking is not. New logic keys off `grooming_job_pets.status = 'complete'` directly and only excludes canceled/no_show/deleted bookings. Added `grooming_job_pets.completed_at` (did not exist) since `updated_at` is re-stamped by the existing generic trigger on ANY later edit (e.g. editing instructions after completion), so it cannot be trusted as "the moment of completion." |
| One-off vs recurring package | `packages.recurrence_interval` (`'none'` = one-off token; `week`/`month`/`year` = recurring) | Reused as the classification field; no new column. |
| Held / available / consumed | `customer_packages.sessions_remaining` (cache) + `package_reservations` (status) + `customer_package_ledger` (consumption sum) | Same formula already used in `preview_package_renewal` (`available = sessions_remaining - reserved_count`); consumed derived from the ledger, never inferred as `total - available`. |

## Checklist

- [x] Worktree/branch created from verified SHA; isolation confirmed (own
      Supabase ports, own `.env.local`, no shared containers).
- [x] Requirement-to-code map (above).
- [ ] Migration: `grooming_job_pets.completed_at` + trigger + backfill;
      `organizations` audit trigger; `followup_retention` settings backfill;
      `app.list_overdue_customers`; `app.list_renewal_queue`;
      `app.update_followup_retention_settings`.
- [ ] `loadFollowupWorkspace` replacement / new queue loaders.
- [ ] `/followups` page: two tabs, URL-persisted filters, settings panel.
- [ ] `/programs/memberships?membershipId=` focused deep link.
- [ ] Message draft UI (follow-up + renewal), template config, placeholder
      validation.
- [ ] SQL behavioral tests for F01-F15 (as actual authenticated roles).
- [ ] JS contract tests.
- [ ] `npm run typecheck/lint/test:batch1a/test:batch1b -w apps/web`.
- [ ] `bash run_all_gates.sh` (PG16 transport).
- [ ] Browser verification (owner, read-only role, groomer/no-access,
      cross-org, mobile).
- [ ] Final F01-F15 evidence table, push, final report.

## Exact resume point (if interrupted)

As of this checkpoint: architecture decided (see map above), no code written
yet beyond this file. Next action: write
`supabase/migrations/20261002090000_retention_renewal_followups.sql`.
