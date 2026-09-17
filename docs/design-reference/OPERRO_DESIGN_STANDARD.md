# Operro Product Design Standard

## Decision

The reviewed interactive prototype is the visual and interaction reference for the real Operro application. The real application keeps its existing Next.js, TypeScript, Supabase, PostgreSQL, RLS, RPC, audit, invoicing, and multi-organization architecture. Only the prototype's presentation system and proven interaction patterns are adopted.

Reference prototype:

`outputs/operro-sales-demo/index.html`

## Product character

Operro should feel calm, capable, friendly, and commercially trustworthy. It serves pet-care businesses, so it may feel warm without becoming playful or childish. Operational and financial screens must remain clear and serious.

Core promise: **The operating system for modern pet-care businesses.**

## Visual foundation

Use these prototype tokens as the starting point for the real application:

| Purpose | Light theme | Dark theme |
|---|---:|---:|
| Navigation | `#0f1b2d` | `#0a1220` |
| Primary action | `#0f8a72` | `#2bb693` |
| Accent | `#f2994a` | `#f2a05c` |
| Page background | `#f6f7f9` | `#0b1220` |
| Surface | `#ffffff` | `#111a2b` |
| Primary text | `#1a2233` | `#e8ecf3` |
| Secondary text | `#5b6472` | `#a8b3c5` |
| Border | `#e4e7ec` | `#22314a` |
| Danger | `#d64545` | `#f2726b` |

Use a 14px default radius, 9px compact radius, restrained shadows, a 14px base interface size, and the system font stack used by the prototype. Preserve clear keyboard focus states and AA-level contrast.

## Application shell

Every authenticated workspace page uses the same shell:

- Collapsible navy sidebar.
- Operro brand at the top.
- Organization and location context visible at all times.
- Role-aware navigation.
- Global search.
- Notifications, help, guided tour, primary create-booking action, and profile controls.
- Responsive mobile sidebar and condensed top bar.
- Breadcrumb, page title, explanatory subtitle, and page actions in a consistent order.

Organization switching must change real tenant context through the existing server-side membership and active-organization mechanism. A client-side switch is never treated as authorization.

## Standard components

Create reusable React components rather than copying page markup:

- `WorkspaceShell`
- `SidebarNavigation`
- `OrganizationSwitcher`
- `LocationFilter`
- `RolePreviewSwitcher` for demo/development only
- `PageHeader`
- `KpiCard`
- `DataCard`
- `DataTable`
- `StatusBadge`
- `FilterPills`
- `EmptyState`
- `Toast`
- `Dialog`
- `ConfirmationDialog`
- `Drawer`
- `Timeline`
- `ResponsiveFormGrid`
- `BarChart`
- `DonutChart`

Components must expose typed props, support light and dark themes, work with keyboard navigation, and avoid embedding business data or Supabase calls.

## Page standards

Use the prototype as the design reference for:

- Dashboard
- Calendar
- Bookings and the multi-pet booking wizard
- Operations board
- Customer 360
- Packages
- Follow-ups
- Finance and invoice details
- Payroll estimates
- My Schedule
- Team
- Leaderboard
- Reports
- Settings

The real app's existing route and domain logic wins when the prototype differs. Do not create duplicate routes merely to match a prototype label. Adapt the design to the existing `/operations`, `/programs`, `/finance`, `/reports`, `/schedule`, Customer 360, and booking flows.

## Interaction standards

- Important mutations require a clear success state.
- Financial or destructive operations require confirmation.
- Multi-pet jobs progress per pet; booking completion follows the real database RPC and existing status-transition rules.
- Drawers provide fast context without losing the current list or board.
- Modals contain short, focused workflows.
- Filters remain visible and consistent across related pages.
- Empty states explain the next useful action.
- Loading and failure states use plain language and never expose raw database errors.
- Tables become stacked, usable layouts at mobile widths.

## Data and security rules

- Never copy the prototype's in-memory arrays into production code.
- Never trust a browser-selected organization, role, price, invoice total, package balance, or booking status.
- Continue to use real RLS, membership claims, server actions, and `supabase.schema("app").rpc(...)` where required.
- Never update `bookings.status` directly. Use the existing transition/completion RPCs.
- Invoice totals and package consumption come from authoritative server logic.
- Keep Customer 360 read-oriented where the current architecture requires it; open existing operational workflows for mutations.
- Do not invent attendance hours, payroll accounting, or groomer revenue-split data that the schema does not support.
- Preserve audit and timeline behavior already present in the application.

## Adoption sequence

1. Add design tokens, typography, icons, focus states, buttons, badges, cards, tables, dialogs, drawers, and form controls.
2. Update `WorkspaceShell`, sidebar, top bar, organization switcher, page headers, and responsive behavior.
3. Restyle the existing Dashboard and Customer 360 without changing their data contracts.
4. Restyle Bookings, Calendar, Operations, and Packages while retaining their current server actions and RPCs.
5. Restyle Finance, Follow-ups, Payroll, My Schedule, Team, Leaderboard, Reports, and Settings.
6. Add the guided demo tour only after the real routes are stable.
7. Run typecheck, build, repository gates, local Supabase integration checks, and browser acceptance testing.

Each stage should be reviewable and independently deployable. Avoid a single replacement commit for the whole interface.

## Definition of done

A migrated page is complete only when:

- It visually follows this standard at desktop and mobile widths.
- It uses shared components and tokens.
- It reads and mutates real Operro data.
- Organization and role access are enforced by the backend.
- Existing workflows still pass typecheck, build, and relevant database gates.
- Loading, empty, error, and success states are present.
- Keyboard focus, labels, dialog behavior, and contrast are usable.
- No prototype-only personal data, HomePaw branding, fake network claims, or in-memory business logic remains.
