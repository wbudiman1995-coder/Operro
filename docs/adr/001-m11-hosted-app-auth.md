# ADR 001 — Hosted Application and Multi-Organization Authentication

Status: Proposed  
Date: 2026-07-28

## Context

Operro has a verified multi-tenant PostgreSQL backend, SDK, grooming preset, service layer, RLS policies, and assembly RPCs.

The repository does not yet contain a hosted web application.

Operro's authorization functions require:

- the authenticated user's ID;
- a top-level JWT claim named `active_org_id`;
- an active membership in that organization;
- the required permission, module, and branch access.

Supabase's standard access token does not automatically contain the Operro-specific `active_org_id` claim.

## Decision

### Application

Create one Next.js App Router application under:

```text
apps/web
```

The application will use TypeScript and remain inside the existing npm workspace monorepo.

### Supabase clients

Use:

- a browser Supabase client for Client Components;
- a cookie-aware server Supabase client for Server Components and actions;
- authenticated user validation for protected server operations.

### Custom access token

Implement a Supabase Custom Access Token Hook that adds:

```json
{
  "active_org_id": "<validated organization UUID>"
}
```

The hook must derive the claim from server-controlled data and must validate that the user still has an active membership.

### Organization selection

Persist one active-organization selection per user.

Switching organizations must happen through a secure database RPC that:

1. receives the requested organization;
2. identifies the authenticated user;
3. verifies active membership;
4. updates the user's active selection;
5. rejects invalid or suspended memberships.

After a successful switch, the application refreshes the Supabase session so the hook can issue a new JWT.

### Authorization

The JWT claim selects the current tenant context.

The database continues to enforce authorization through:

- organization isolation;
- active membership;
- permissions;
- modules;
- branch access;
- RLS policies.

The JWT claim alone never grants access.

### Deployment

Deploy `apps/web` as a Vercel project.

Supabase secrets are divided into:

- browser-safe project URL and publishable key;
- server-only secrets, where genuinely required.

The service-role key must never be included in client code.

## Alternatives Considered

### Store the organization only in browser state

Rejected because browser state cannot establish a trusted RLS tenant context.

### Let users directly edit `app_metadata`

Rejected because authorization claims must remain server controlled.

### Send the organization as an arbitrary request header

Rejected because the existing authorization contract reads `active_org_id` from authenticated JWT claims.

### Build the frontend before resolving authentication

Rejected because UI work would depend on an incomplete tenant-security model.

### Add Turborepo immediately

Deferred. The existing npm workspace is sufficient for one app and three packages. Additional build orchestration can be evaluated later.

## Consequences

### Positive

- Tenant context is cryptographically attached to the access token.
- Existing RLS helpers remain unchanged.
- Organization switching is explicit and auditable.
- The browser cannot forge tenant context.
- The architecture supports users belonging to multiple organizations.

### Negative

- Switching organizations requires a session refresh.
- A new persistence mechanism and RPC will be required.
- Hook behavior must be covered by hosted authentication tests.
- Token refresh failures require clear application handling.

## Implementation Constraint

No database implementation is authorized by this ADR alone.

The future schema change, hook function, grants, switch RPC, rollback procedure, and tests must be reviewed before a new migration is created.
