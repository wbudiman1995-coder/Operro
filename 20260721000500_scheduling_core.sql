-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0001_extensions_and_helpers
-- Milestone        1 — PostgreSQL Foundation
-- Purpose          Establish the database substrate every later milestone
--                  builds on: extensions, a private helper schema, UUIDv7
--                  generation, JWT/workspace claim readers, and the generic
--                  trigger + audit + soft-delete machinery. No business
--                  tables are created here.
-- Dependencies     None. This is the first migration.
-- Objects Created  SCHEMA  app
--                  FUNCTION app.uuid_generate_v7()
--                  FUNCTION app.current_user_id()
--                  FUNCTION app.active_org_id()
--                  FUNCTION app.is_platform_admin()
--                  FUNCTION app.jwt_claim(text)
--                  FUNCTION app.tg_set_updated_at()
--                  FUNCTION app.tg_set_audit_columns()
--                  FUNCTION app.tg_block_hard_delete()
--                  FUNCTION app.tg_write_audit_log()
--                  TABLE    app.audit_log   (infrastructure, not business data)
-- Objects Modified None.
-- Indexes          app.audit_log: (organization_id, occurred_at desc),
--                  (entity_table, entity_id)
-- Constraints      app.audit_log PK; check on action domain.
-- Triggers         None attached here — trigger *functions* only. Attachment
--                  happens per-table in Milestones 2–7.
-- Functions        See Objects Created.
-- RLS Policies     None here. RLS is enabled platform-wide in Milestone 8;
--                  app.audit_log gets its policy there.
-- Breaking Changes None (greenfield).
-- Rollback         DROP SCHEMA app CASCADE;  DROP EXTENSION IF EXISTS
--                  btree_gist;  (pgcrypto is left in place — harmless.)
-- Notes            app schema is intentionally NOT exposed via PostgREST
--                  (not added to the API schema list), so these helpers are
--                  server/RLS-internal only.
-- =====================================================================

-- ---------------------------------------------------------------------
-- SECTION 001 — Extensions
-- ---------------------------------------------------------------------
-- pgcrypto : gen_random_bytes() for UUIDv7 entropy.
-- btree_gist : lets GiST exclusion constraints mix scalar equality
--              (resource_id, organization_id) with a range (&&). Enabled
--              now so Milestone 5 occupancy constraints need no new setup.
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- SECTION 002 — Private helper schema
-- ---------------------------------------------------------------------
create schema if not exists app;
comment on schema app is
  'Operro internal helpers (UUIDv7, JWT/workspace claim readers, trigger '
  'functions, audit). NOT exposed via PostgREST. Referenced by RLS and triggers.';

-- ---------------------------------------------------------------------
-- SECTION 003 — UUIDv7 generation
-- ---------------------------------------------------------------------
-- Time-ordered UUID (RFC 9562 v7): 48-bit unix-ms prefix + version/variant
-- bits + random tail. Ordered generation keeps B-tree PK indexes compact at
-- 10k-org write volume (ADR-001 Decision 4). Replace with the native
-- uuidv7() built-in once the project is on PostgreSQL 18+.
create or replace function app.uuid_generate_v7()
returns uuid
language plpgsql
volatile
parallel safe
as $$
declare
  ts_ms  bytea;
  buf    bytea;
begin
  -- 48-bit big-endian millisecond timestamp (last 6 bytes of an int8).
  ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  -- 6 timestamp bytes + 10 random bytes = 16.
  buf := ts_ms || gen_random_bytes(10);
  -- Version nibble -> 7 (high nibble of byte index 6).
  buf := set_byte(buf, 6, (7 << 4) | (get_byte(buf, 6) & 15));
  -- Variant bits -> 10xx (top two bits of byte index 8).
  buf := set_byte(buf, 8, (2 << 6) | (get_byte(buf, 8) & 63));
  return encode(buf, 'hex')::uuid;
end;
$$;
comment on function app.uuid_generate_v7() is
  'RFC 9562 UUIDv7 (time-ordered). Default for all Operro primary keys.';

-- ---------------------------------------------------------------------
-- SECTION 004 — JWT / Workspace claim readers
-- ---------------------------------------------------------------------
-- These read only the signed JWT (never a table), so they are cheap enough
-- to call per-row inside RLS. STABLE = evaluated once per statement.
--
-- Claim contract (written by the Supabase custom access-token hook,
-- delivered in Milestone 2):
--   * active_org_id          top-level claim; switchable per workspace,
--                            re-minted on workspace switch.
--   * app_metadata.is_platform_admin
--                            durable identity trait; lives in app_metadata
--                            because that object is server-controlled and not
--                            editable by the end user.

create or replace function app.jwt_claim(claim text)
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> claim, '');
$$;
comment on function app.jwt_claim(text) is
  'Reads a top-level claim from the request JWT. Returns null if absent.';

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
  -- 'sub' is the Supabase auth user id. Mirrors auth.uid() but decoupled
  -- from the auth schema for testability.
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;
comment on function app.current_user_id() is
  'Global User id (auth.users.id) of the requester, or null.';

create or replace function app.active_org_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'active_org_id', '')::uuid;
$$;
comment on function app.active_org_id() is
  'Active workspace/organization id from the JWT (ADR-001 Decision 1). '
  'RLS must also verify a live Membership for (current_user_id, active_org_id).';

create or replace function app.is_platform_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb
       #>> '{app_metadata,is_platform_admin}')::boolean,
    false);
$$;
comment on function app.is_platform_admin() is
  'True for Operro platform staff. Sourced from server-controlled app_metadata.';

-- ---------------------------------------------------------------------
-- SECTION 005 — Generic trigger functions (attached per-table later)
-- ---------------------------------------------------------------------

-- Maintain updated_at on every UPDATE.
create or replace function app.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Stamp created_by / updated_by from the requester. Assumes the table has
-- created_by uuid and updated_by uuid columns (audit-column convention).
create or replace function app.tg_set_audit_columns()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, app.current_user_id());
    new.updated_by := new.created_by;
  elsif tg_op = 'UPDATE' then
    new.updated_by := app.current_user_id();
  end if;
  return new;
end;
$$;

-- Enforce append-only / soft-delete on immutable tables (financial records,
-- ADR + Milestone 6). Blocks physical DELETE; callers must set deleted_at.
create or replace function app.tg_block_hard_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Hard delete blocked on % (append-only table). Set deleted_at instead.',
    tg_table_name
    using errcode = 'restrict_violation';
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- SECTION 006 — Audit infrastructure
-- ---------------------------------------------------------------------
-- Infrastructure table (not business data). Every mutation on an audited
-- table lands here as an immutable row. Carries organization_id so Milestone
-- 8 RLS can scope reads per tenant. The generic trigger derives the org id
-- from the row's own organization_id column, falling back to active_org_id().
create table if not exists app.audit_log (
  id              uuid        primary key default app.uuid_generate_v7(),
  organization_id uuid        not null,
  actor_id        uuid,                       -- app.current_user_id() at write time
  action          text        not null check (action in ('INSERT','UPDATE','DELETE')),
  entity_table    text        not null,
  entity_id       uuid,
  diff            jsonb       not null default '{}'::jsonb,  -- {old, new}
  occurred_at     timestamptz not null default now()
);
comment on table app.audit_log is
  'Immutable audit trail of mutations across tenant tables. Written by '
  'app.tg_write_audit_log(). RLS applied in Milestone 8.';

create index if not exists audit_log_org_time_idx
  on app.audit_log (organization_id, occurred_at desc);
create index if not exists audit_log_entity_idx
  on app.audit_log (entity_table, entity_id);

create or replace function app.tg_write_audit_log()
returns trigger
language plpgsql
as $$
declare
  v_org  uuid;
  v_id   uuid;
  v_old  jsonb;
  v_new  jsonb;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_org := coalesce((v_old ->> 'organization_id')::uuid, app.active_org_id());
    v_id  := (v_old ->> 'id')::uuid;
  else
    v_new := to_jsonb(new);
    v_org := coalesce((v_new ->> 'organization_id')::uuid, app.active_org_id());
    v_id  := (v_new ->> 'id')::uuid;
    if tg_op = 'UPDATE' then v_old := to_jsonb(old); end if;
  end if;

  insert into app.audit_log (organization_id, actor_id, action, entity_table, entity_id, diff)
  values (
    v_org,
    app.current_user_id(),
    tg_op,
    tg_table_name,
    v_id,
    jsonb_strip_nulls(jsonb_build_object('old', v_old, 'new', v_new))
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
comment on function app.tg_write_audit_log() is
  'AFTER INSERT/UPDATE/DELETE trigger. Records the mutation in app.audit_log. '
  'Attach only to tables that carry an organization_id column.';

-- =====================================================================
-- END 0001_extensions_and_helpers
-- =====================================================================
