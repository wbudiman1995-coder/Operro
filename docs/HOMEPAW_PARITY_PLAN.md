# Operro × HomePaw parity plan

Source reviewed on 2026-09-18: `index (2).html`, `groomer (3).html`, `booking (1).html`, `join (2).html`, `expand-gmaps.js`, and the 44-section HomePaw sales catalog supplied by the owner.

## Product rule

Operro remains multi-tenant and multi-branch. Every appointment supports `in_store`, `home`, or `pickup_delivery`. HomePaw workflows are adapted to Operro's PostgreSQL/RLS model; the standalone HTML data layer is reference logic, not a second source of truth.

## Current parity by catalog section

| # | HomePaw capability | Operro status | Required work |
|---|---|---|---|
| 1 | Dashboard and analytics | Partial | Period selector, prior-period comparison, configurable cards, alerts, acquisition-source ROI |
| 2 | Customer CRM | Partial+ | Maps paste/short-link parsing added; add sort/filter, customer code, richer editing and bulk location repair |
| 3 | Customer 360 | Partial+ | Addresses, spend, pets, booking, invoice, package, notes and timeline exist; add editing, balances, visit summary and custom fields |
| 4 | Pet database | Partial | Add pet CRUD UI, coat/profile fields, wash counters and last-groomed automation |
| 5 | Styling references | Implemented foundation | Private tenant storage, browser compression, expiry, Customer 360 upload/delete and groomer schedule visibility exist; add public onboarding upload and automated expired-byte cleanup |
| 6 | Fast customer entry | Implemented foundation | Booking-chat parser, editable multi-pet preview, Maps expansion, duplicate-phone guard and tenant-scoped import are live; expand fuzzy city dictionaries as real templates require |
| 7 | Customer self-onboarding | Implemented | Hashed two-day single-use links, public multi-pet form, token-scoped private styling uploads, configurable WhatsApp template, duplicate warning, approve/merge, reject and revoke exist |
| 8 | Complimentary next appointment | Implemented | One-use percent/fixed rules for Basic Grooming, Styling and Other; atomic next-booking consumption, immutable invoice-line discounts, CRM indicator and recurring-series protection |
| 9 | Advanced calendar | Implemented | Day/3-day/week time grids, branch/groomer filters, desktop drag/drop, shift or mobile long-press selection, grouped time moves, mass cancellation, groomer reassignment and subscription/prepaid/free source badges; every move is one collision-safe audited transaction |
| 10 | Booking wizard | Implemented | Multi-pet/service/groomer, fulfillment, coverage/travel preview, ranked seven-day slots, category percent/fixed discounts, separate customer/groomer/internal notes, and explicit per-service package allocation with server-side validation and reservation |
| 11 | Recurring appointments | Implemented | Weekly/biweekly/monthly materialization preserves operational snapshots; collisions can skip, stop atomically, or search eight nearby 30-minute alternatives; cancellation previews and applies current, current-and-future, or entire-series scope through the canonical state machine |
| 12 | Route-aware scheduling | Implemented | Seven-day common-slot search ranks by Haversine travel, previous stop or branch base, traffic and workload; staff can choose a geocoded customer as route anchor, and same-city groomer days rank above incompatible city commitments with visible warnings |
| 13 | Availability and blocked days | Implemented | Weekly per-groomer schedules and one-off blackouts are joined by dated served-city planning and branch-wide closure windows; closures appear on the calendar, remove slots from recommendations, and database triggers reject booking/closure races in both directions |
| 14 | Safe deletion | Implemented | Series-scoped archive preview and current/future/all actions refuse financial links, soft-delete linked visit rows, release occupied slots, atomically reverse or release package reservations, and record an audited timeline event |
| 15 | Groomer management | Implemented | Add/edit/status/archive, phone, personal calendar color, Maps/base coordinates, membership link, appointment and current-month lateness counts, join date, compensation, weekly/city schedule access and copyable filtered calendar links |
| 16 | Attendance | Implemented | Assigned groomers check in with compressed photo and GPS; server time and configurable grace classify lateness; missing-photo materialization, reasons, audited payroll waiver, cycle navigation, per-groomer summaries, signed photos and GPS history are included |
| 17 | Groomer performance | Partial | Revenue/activity views exist; add retention, duration, documentation and complaints metrics |
| 18 | Leaderboard | Partial | Ranking route exists; expand metrics and drill-down |
| 19 | Complaints | Missing | Complaint lifecycle, links, severity, recovery notes, audit and export |
| 20 | Service and invoice creation | Partial | Completion-to-invoice works; add billing modes, invoice edit protections, manual groomer and due-date workflow |
| 21 | Catalog and pricing | Partial | Services/duration/base prices exist; add size-based price matrix and standard HomePaw templates |
| 22 | Discounts and charges | Partial | Package coverage exists; add invoice/pet/service/category discounts and typed charges including transport |
| 23 | Coverage detection | Partial | Ledger-backed package reservation exists; improve allocation visibility and over-allocation warnings |
| 24 | Packages and memberships | Partial | Package sale and ledger exist; add recurring tiers, per-pet terms, source invoice and renewal lifecycle |
| 25 | Membership administration | Partial | Balances exist; add lifecycle filters, urgency, edit/renew/details/archive |
| 26 | Subscription reconciliation | Missing | Review-only recomputation and guarded per-membership repair |
| 27 | Invoice documents and communication | Partial | Invoice lines exist; add branded preview/PDF, terms/photo pages and WhatsApp templates |
| 28 | Grooming photo documentation | Partial+ | Private categorized field capture/gallery exists; add compression, deletion, admin history and document inclusion |
| 29 | Payment control | Partial | Payments exist; add screenshot-confirmed/bank-validated stages and locked validated records |
| 30 | Visit management | Partial | Booking/job execution exists; add explicit visit register, manual billing and unmatched-visit handling |
| 31 | Financial operations | Partial | Invoices, payments and expenses exist; add capital/cash-on-hand, refunds, status drill-down and exports |
| 32 | Payroll engine | Partial | Compensation and commission exist; add attendance/hours, late adjustments, custom rows and snapshots |
| 33 | Payroll exports | Missing | Cycle CSV/XLSX/PDF and groomer statements |
| 34 | WhatsApp center | Partial | Direct customer/groomer links exist; add configurable templates and batch reminder/renewal workflows |
| 35 | Retention and renewal | Partial | Follow-ups route exists; add inactivity rules, expiring package queue and conversion tracking |
| 36 | Audit history | Implemented foundation | Generic audit/timeline exists; expand labels and entity-specific views |
| 37 | Operational reconciliation | Missing | Visits without invoice, invoice without completed visit, payroll mismatch and count checks |
| 38 | Export and ownership | Missing | Organization-scoped Excel/CSV exports and backup download |
| 39 | Business configuration | Partial | Organization/branch basics exist; add branding, banks, billing/payroll cycles, service areas and templates UI |
| 40 | Custom fields | Schema metadata only | Admin builder and customer/pet rendering/editor |
| 41 | Accounts and permissions | Implemented foundation | Multi-org membership and capabilities exist; add staff invitation and role-management UI |
| 42 | Personal preferences | Partial | Responsive shell exists; add language, landing page, calendar and dashboard preferences |
| 43 | Storage and maintenance | Partial+ | Private tenant-partitioned evidence buckets, per-org reference retention and bounded orphan/expiry cleanup exist; add usage charts and scheduled cleanup |
| 44 | Reliability and safeguards | Partial+ | RLS, audit, immutable snapshots, state RPCs and tests exist; add idempotency for remaining financial writes, monitoring and recovery UI |

## Delivery order

1. **Home-service foundation** — addresses, Maps parsing, service-area preview, travel snapshot, dispatch and customer location completeness.
2. **Groomer field workflow** — private before/after/issue photos, attendance GPS/photo, notes, timing and completion guardrails.
3. **Customer acquisition** — public onboarding links, fast paste import, customer portal/public booking and WhatsApp invitations.
4. **Route-aware scheduling** — ranked slots, travel estimates, base/previous-stop logic, recurring bookings and safe series changes.
5. **Service-to-cash** — invoice editor/PDF/WhatsApp, discounts/charges, package/membership lifecycle and payment validation.
6. **People and quality** — payroll/attendance, performance, leaderboard, complaints and service recovery.
7. **Control plane** — dashboard comparisons, reconciliation, exports, configuration, custom fields, preferences and storage maintenance.

Each batch must retain organization isolation, branch scoping, capability checks, immutable booking/invoice snapshots and auditable writes.
