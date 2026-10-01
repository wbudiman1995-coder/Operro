# HomePaw → Operro parity audit (1 October 2026)

This updates the stale 18 September plan against the current integration tree. **Implemented** means a real route/RPC and tests exist; it does **not** mean the owner's live workflow has passed QC. **Partial** means some working pieces exist but an important HomePaw behavior is absent. **Missing** means no usable feature surface. The count is **29 implemented, 12 partial, 3 missing**. The owner should use this as a QC map, not a claim that 29 are perfect clones.

| # | Capability | Status | Evidence / remaining gap |
|---|---|---|---|
| 1 | Dashboard analytics | Partial | `/dashboard`; period comparison, cards and acquisition ROI absent. |
| 2 | Customer CRM | Partial | `/customers`, Customer 360, onboarding, HomePaw-style search/filter/sort and eight-sheet XLSX export; bulk edit and persistent customer code absent. Export requires live permission/data QC. |
| 3 | Customer 360 | Partial | `/customers/[customerId]`; address, pets, history, invoices and packages present; editing and custom fields incomplete. |
| 4 | Pet database | Partial | `pets`, multi-pet intake and size logic; full standalone pet CRUD, coat profile and wash counter absent. |
| 5 | Styling references | Implemented | Public onboarding upload, Customer 360 and groomer evidence, private Storage and cleanup (`public-onboarding-form`, `S27-S30-HANDOFF`). |
| 6 | Fast customer entry | Implemented | Chat import and duplicate check (`fast-customer-import`, `createCustomerAction`). |
| 7 | Self onboarding | Implemented | Single-use link, amend/approve/reject queue, multi-pet, address and optional photos (`/join`, `/customers/onboarding`). |
| 8 | Complimentary next visit | Implemented | One-use discount/line snapshot migration `20260919110000`. |
| 9 | Advanced calendar | Implemented | `/schedule`, day/3-day/week, slot selection, moves and filters; owner must check live UX. |
| 10 | Booking wizard | Implemented | Calendar wizard, multi-pet/services, route/coverage and package allocation. |
| 11 | Recurring appointments | Implemented | Series creation and cancellation in booking migrations and UI. |
| 12 | Route-aware scheduling | Implemented | `app` availability RPCs, travel/area ranks and route anchor. |
| 13 | Availability/blocked days | Implemented | Groomer working windows, closures, collision guards. |
| 14 | Safe deletion | Implemented | Audited series archive with financial-link refusal. |
| 15 | Groomer management | Implemented | `/catalog`, resource/membership link, branch assignment and profiles. |
| 16 | Attendance | Implemented | `/attendance`, GPS/photo check-in and payroll classification. |
| 17 | Groomer performance | Implemented | `/leaderboard/[resourceId]` drill-down and attribution. |
| 18 | Leaderboard | Implemented | `/leaderboard` monthly ranking. |
| 19 | Complaints | Implemented | `/complaints`, lifecycle, role guards and CSV. |
| 20 | Service/customer invoice creation | Implemented | `/invoices/new`, booking/visit/package invoice, line snapshots, document and PDF. This is distinct from Operro's new platform billing invoice. |
| 21 | Catalog/price | Implemented | `/catalog`, size price/duration matrix; this change adds service categories and custom pet-type pricing. |
| 22 | Discounts/charges | Implemented | Invoice/pet/service/category rules and transport fee. |
| 23 | Package coverage | Implemented | Reservation-aware preview and server-side eligibility. |
| 24 | Packages/memberships | Implemented | `/programs`, sale, renew and ledger. |
| 25 | Membership administration | Implemented | `/programs/memberships`, corrections and guarded renew/archive. |
| 26 | Reconciliation | Implemented | Package read-only reconciliation and guarded repair. This does not cover all operational reconciliation (#37). |
| 27 | Invoice documents | Implemented | `/invoices/[invoiceId]`, branded preview, PDF, bank accounts and WhatsApp handoff; see `S27-S30-HANDOFF.md`. |
| 28 | Grooming photos | Implemented | Before/after zones, evidence history, retention and role-limited storage. |
| 29 | Payment control | Implemented | Screenshot/validation stages and payment register. |
| 30 | Visit management | Implemented | `/visits`, manual billing, undo and invoice-from-visit. |
| 31 | Financial operations | Partial | `/finance`, payment register, expenses/refunds; no complete capital/cash-on-hand and export suite. |
| 32 | Payroll engine | Implemented | `/payroll`, attendance and immutable paid snapshots; see `ENGINE-3-S32-S33-HANDOFF.md`. |
| 33 | Payroll exports | Implemented | XLSX, CSV and per-groomer PDF (`/payroll/export`). |
| 34 | WhatsApp center | Partial | Invoice templates and follow-up drafts exist; no unified batch messaging center/delivery log. |
| 35 | Retention/renewal | Implemented | `/followups`, renewal queue, drafts and owner settings; see `S35-HANDOFF.md`. |
| 36 | Audit history | Partial | Generic audit/timeline exists; labels and cross-entity review UI incomplete. |
| 37 | Operational reconciliation | Missing | No unified view for visit/invoice/payroll mismatch across modules. |
| 38 | Export/ownership | Partial | CRM eight-sheet XLSX, payroll XLSX/CSV and complaint CSV; no organization-wide backup including files/configuration. |
| 39 | Business configuration | Partial | Branding, banks, service areas and access controls exist; not all HomePaw business settings are exposed. |
| 40 | Custom fields | Missing | Metadata supports extension; no owner-configurable customer/pet field builder/editor. |
| 41 | Accounts/permissions | Partial | Platform invitations, business owner Admin checklist, groomer accounts; live invite and multi-org owner QC still required. |
| 42 | Personal preferences | Missing | No per-user landing/calendar/dashboard/language preferences. |
| 43 | Storage/maintenance | Partial | Org file meter, platform project DB and file meter, cleanup and manual capacity requests; no per-org database-byte accounting, scheduled cleanup or billing automation. |
| 44 | Reliability/safeguards | Partial | RLS, audit, financial snapshots, migration/test gates; monitoring/recovery UI and some real-world workflows need QC. |

## Current owner QC priorities

1. Claim a new `Pemilik` invitation in an independent email, then set Admin permissions in that business's Settings; verify Operro's platform owner cannot read or set that checklist.
2. Add a custom pet type and a new service category. Configure explicit price/time for the type; create a pet and calendar booking; check the stored invoice line price and duration.
3. Submit public registration with that type, amend it in the queue, approve it, and verify species is preserved in Customer 360.
4. Export both CRM XLSX options. Verify the complete workbook has Customers, Pets, Appointments, Invoices, Visits, Subscriptions, Tokens (package ledger), Complaints; only active-organization rows appear. Check spreadsheet cells beginning `=`, `+`, `-`, `@` remain text.
5. Create monthly Operro billing, issue the platform invoice, download PDF and view it as that business owner; mark paid and verify amount/due cannot be rewritten. A suspended owner must still be able to open their invoice.
6. Compare the actual HomePaw workflows for #1–4, #31, #34, and #36–44 before advertising full parity.

The workspace file meter counts stored files including photos/documents. The platform DB meter uses `pg_database_size` and therefore includes schedules and metadata **for the whole Supabase project**, not per business. Neither meter is Vercel bandwidth/functions, Supabase egress, or an exact provider-billing quota. The provider Usage dashboards remain authoritative.
