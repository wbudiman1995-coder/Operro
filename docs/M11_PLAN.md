# Operro M11 — Hosted Application and Authentication

Status: Proposed  
Branch: `plan/m11-hosted-app-auth`

## 1. Objective

Create Operro's first hosted web application and connect it safely to the existing Supabase multi-tenant backend.

M11 converts the verified backend foundation into an authenticated application that can be deployed to Vercel and call the existing `app` RPC interface.

## 2. Scope

M11 includes:

1. Next.js application under `apps/web`.
2. Supabase SSR authentication.
3. Login, logout, callback, and protected-route handling.
4. Custom Access Token Hook for `active_org_id`.
5. Active-organization selection and switching.
6. JWT refresh after an organization switch.
7. Connection to the existing exposed `app` RPC functions.
8. Minimal authenticated application shell.
9. Vercel preview deployment.
10. Hosted authenticated Data API smoke tests.

## 3. Repository Structure

```text
apps/
  web/
    src/
      app/
      components/
      lib/
        supabase/
        auth/
        operro/
packages/
  sdk/
  backend/
  preset-grooming/
supabase/
  migrations/
  tests/
```

The root npm workspace configuration will later include:

```json
[
  "apps/*",
  "packages/*"
]
```

## 4. Authentication Architecture

### Login

1. User signs in through Supabase Auth.
2. Supabase runs the Custom Access Token Hook.
3. The hook reads the user's selected active organization.
4. The hook verifies that the user has an active membership.
5. The hook adds `active_org_id` to the top-level JWT claims.
6. The Next.js application receives the session through secure cookies.

### First login without an active organization

1. User signs in successfully.
2. `active_org_id` may be absent until an organization is selected.
3. The application reads the user's own memberships.
4. The user selects an organization.
5. The secure switch RPC records the selection.
6. The application refreshes the session.
7. The newly issued token contains `active_org_id`.

### Organization switching

1. User selects another organization.
2. A security-definer RPC validates active membership in that organization.
3. The RPC stores the selected organization.
4. The application calls `refreshSession()`.
5. The Custom Access Token Hook issues a new JWT.
6. The application verifies the new `active_org_id` claim.
7. Tenant-scoped requests continue using the refreshed token.

## 5. Security Rules

- Never expose the Supabase service-role key to the browser.
- Browser requests use the authenticated user's JWT.
- Organization selection must be validated against live membership.
- The client may request an organization switch but cannot write JWT claims.
- Missing or invalid `active_org_id` must fail closed.
- Server code must validate the authenticated user.
- Existing RLS remains the final authorization boundary.
- Internal RPCs remain unexposed.
- Frozen migrations must not be edited.

## 6. Delivery Phases

### Phase A — Documentation and contracts

- Approve this plan and its ADR.
- Define routes, environment variables, and test cases.
- Identify the minimal future database change.
- No migration is created in this phase.

### Phase B — Web application foundation

- Add `apps/web`.
- Add Next.js App Router, TypeScript, and linting.
- Add Supabase browser and server clients.
- Add login, callback, logout, and protected layouts.
- Add a minimal application shell.

### Phase C — Active-organization authentication

- Add the approved new migration.
- Add active-organization persistence.
- Add organization-switch RPC.
- Add Custom Access Token Hook.
- Add membership and claim validation tests.

### Phase D — Backend integration

- Add typed wrappers around existing `app` RPCs.
- Verify the eight exposed client-facing RPCs.
- Confirm internal helper RPCs remain inaccessible.
- Add authenticated Data API tests.

### Phase E — Vercel deployment

- Create a Vercel project rooted at `apps/web`.
- Configure preview environment variables.
- Deploy the planning implementation.
- Run hosted login, organization-switch, RLS, and RPC smoke tests.

### Phase F — UI design

- Produce the full application design specification with Claude.
- Apply the approved design system after authentication works.
- Keep visual design separate from authorization correctness.

## 7. Acceptance Criteria

M11 is complete only when:

- The web app builds and type-checks in CI.
- A user can sign in and sign out.
- Protected routes reject unauthenticated users.
- A user can view only their own memberships.
- A user can select an organization where membership is active.
- The refreshed JWT contains the correct `active_org_id`.
- Invalid organization selection is rejected.
- Cross-organization access is denied by RLS.
- An exposed assembly RPC succeeds through the hosted Data API.
- Internal RPCs remain inaccessible.
- A Vercel preview deployment passes the smoke-test checklist.
- No service-role secret is present in browser code or client bundles.

## 8. Explicitly Out of Scope

- Full grooming operational UI.
- Accounting or ERP expansion.
- Billing and subscription checkout.
- Notifications and WhatsApp integration.
- Mobile applications.
- Production domain cutover.
- Production customer data migration.
- Editing migrations already merged in Batch 2.

## 9. Migration Rule

This planning branch must not introduce a new migration.

Any database change for the access-token hook, active-organization persistence, or switch RPC requires separate review and approval before implementation.
