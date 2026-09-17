# Prompt for Claude Code

You are working in the real Operro repository on `feat/m13-booking` or its current successor branch.

Adopt the supplied Operro sales prototype as the official visual and interaction standard for the real application. The reference is `docs/design-reference/index.html`. Read it completely, then inspect the real application before editing anything.

This is a design-system migration, not a rewrite. Preserve the existing Next.js, TypeScript, Supabase, PostgreSQL, RLS, RPC, audit, invoicing, booking, and multi-organization architecture. Do not copy the prototype's in-memory arrays or client-side business logic into production.

Before changing code:

1. Read the repository guidance and package scripts.
2. Inspect `WorkspaceShell`, global styles, shared components, navigation, data-loading modules, server actions, and existing routes.
3. Map the prototype pages to existing real routes. In particular, inspect `/operations`, `/programs`, `/finance`, `/reports`, `/schedule`, booking creation, and Customer 360 before proposing a new route.
4. Identify the smallest first migration stage: design tokens, shared primitives, and the workspace shell.
5. Report the exact files you intend to change and why.

Non-negotiable rules:

- Keep Operro multi-organization and multi-location.
- Backend membership and RLS remain authoritative. A browser-selected organization or role is never authorization.
- Never update `bookings.status` directly. Continue using the existing transition/completion RPCs.
- Use `supabase.schema("app").rpc(...)` for app-schema RPCs.
- Preserve the existing booking and invoice behavior in `/operations`.
- Preserve the current Customer 360 architecture and open the established operational flow for mutations when appropriate.
- Do not invent payroll hours, accounting integration, package-to-invoice behavior, or groomer revenue splits where the database does not support them.
- Do not add another disconnected UI implementation beside the existing application.
- Do not touch production Supabase.
- Do not commit, push, or open a PR unless explicitly instructed.

Implement in reviewable stages:

1. Convert the prototype's colors, spacing, typography, radii, shadows, focus states, dark theme, and responsive breakpoints into reusable application tokens.
2. Build or refine typed shared components for buttons, badges, cards, tables, filters, dialogs, drawers, empty states, toasts, page headers, and charts.
3. Update the real workspace shell, sidebar, top bar, organization/location context, and mobile navigation.
4. Migrate Dashboard and Customer 360 as the first representative pages, retaining their real loaders and actions.
5. Stop and provide screenshots and exact validation output before migrating the remaining routes.

Visual direction:

- Deep navy navigation.
- White/light-neutral content surfaces.
- Teal primary actions.
- Warm coral used sparingly.
- Rounded cards with restrained shadows.
- Friendly pet-care tone without childish decoration.
- Dense operational information that remains easy to scan.
- Consistent desktop and mobile behavior.
- No emoji used as application icons.
- Clear keyboard focus and accessible form/dialog semantics.

Validation for the first stage:

- Run the repository typecheck.
- Run the production build.
- Run `bash run_all_gates.sh` against local Supabase only when the environment supports it.
- Exercise the migrated pages using the local/dev database, never production.
- Capture desktop and 375px mobile screenshots of the workspace shell, Dashboard, and Customer 360.
- Paste exact command output. Do not report a check as passed without showing its result.

Keep changes small enough to review. If the real repository conflicts with the prototype, preserve the real domain workflow and adapt the presentation to it.
