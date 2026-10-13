-- QC completion: business-owned catalog configuration, code-only groomer access,
-- branch creation, and explicitly-confirmed platform deletion.
begin;

-- A business owner can select dynamic sizing for their own active workspace.
-- Layout writes remain owner-only and the tenant/optimistic-lock checks stay in
-- app.size_band_lock_settings.
create or replace function app.size_band_authorize(p_org uuid, p_kind text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_actor text;
begin
  if p_org is null or p_org is distinct from app.fn_active_organization() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if app.is_operro_owner() then v_actor := 'platform';
  elsif app.is_business_owner(p_org) then v_actor := 'owner';
  else raise exception 'not_authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.organizations o where o.id = p_org and o.status in ('trial','active') and o.deleted_at is null) then
    raise exception 'organization_unavailable' using errcode = '22023';
  end if;
  return v_actor;
end;
$$;

create function app.create_branch(p_name text, p_timezone text default 'Asia/Jakarta') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_branch uuid;
begin
  p_name := btrim(p_name); p_timezone := btrim(coalesce(p_timezone, 'Asia/Jakarta'));
  if v_org is null or not (app.is_business_owner(v_org) or app.has_permission('branches.manage')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if length(p_name) not between 2 and 100 or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'invalid_branch' using errcode = '22023';
  end if;
  insert into public.branches(organization_id, name, timezone, status, is_default)
  values(v_org, p_name, p_timezone, 'active', false)
  returning id into v_branch;
  return v_branch;
end;
$$;
revoke all on function app.create_branch(text,text) from public, anon;
grant execute on function app.create_branch(text,text) to authenticated;

-- Codes are stored only as SHA-256 hashes. A code is intentionally single-use:
-- it activates a browser-only anonymous Supabase session for one groomer, with
-- no email or password registration. Regenerate a code for another device.
create table public.groomer_access_codes (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  issued_at timestamptz not null default now(),
  issued_by uuid not null references auth.users(id),
  claimed_at timestamptz,
  claimed_by uuid references auth.users(id),
  revoked_at timestamptz,
  constraint groomer_access_codes_expiry check (expires_at > issued_at)
);
create index groomer_access_codes_resource_open on public.groomer_access_codes(resource_id) where claimed_at is null and revoked_at is null;
alter table public.groomer_access_codes enable row level security;
revoke all on public.groomer_access_codes from public, anon, authenticated;

create function app.issue_groomer_access_code(p_resource uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_code text; v_hash text;
begin
  if v_org is null or not app.has_permission('resource.manage') or p_resource is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not exists (select 1 from public.resources r where r.id=p_resource and r.organization_id=v_org and r.kind='staff' and r.status='active' and r.deleted_at is null) then
    raise exception 'resource_not_available' using errcode = '22023';
  end if;
  update public.groomer_access_codes set revoked_at=now()
   where organization_id=v_org and resource_id=p_resource and claimed_at is null and revoked_at is null;
  loop
    v_code := 'GRM-' || upper(substr(encode(extensions.gen_random_bytes(9), 'hex'), 1, 12));
    v_hash := encode(extensions.digest(v_code, 'sha256'), 'hex');
    begin
      insert into public.groomer_access_codes(organization_id,resource_id,code_hash,expires_at,issued_by)
      values(v_org,p_resource,v_hash,now()+interval '30 days',auth.uid());
      exit;
    exception when unique_violation then
      -- astronomically unlikely, but never reveal or reuse an existing code.
    end;
  end loop;
  return v_code;
end;
$$;

create function app.claim_groomer_access_code(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_code public.groomer_access_codes; v_resource public.resources; v_role uuid; v_membership uuid; v_actor uuid := auth.uid();
begin
  if v_actor is null or length(btrim(coalesce(p_code,''))) < 8 then
    raise exception 'invalid_groomer_code' using errcode = '22023';
  end if;
  select * into v_code from public.groomer_access_codes
   where code_hash=encode(extensions.digest(upper(btrim(p_code)), 'sha256'), 'hex') for update;
  if not found or v_code.revoked_at is not null or v_code.claimed_at is not null or v_code.expires_at <= now() then
    raise exception 'invalid_or_expired_groomer_code' using errcode = '22023';
  end if;
  select * into v_resource from public.resources where id=v_code.resource_id and organization_id=v_code.organization_id for update;
  if not found or v_resource.kind <> 'staff' or v_resource.status <> 'active' or v_resource.deleted_at is not null then
    raise exception 'resource_not_available' using errcode = '22023';
  end if;
  if exists (select 1 from public.memberships m where m.organization_id=v_code.organization_id and m.user_id=v_actor and m.deleted_at is null) then
    raise exception 'code_requires_new_groomer_session' using errcode = '22023';
  end if;
  select id into v_role from public.roles where organization_id=v_code.organization_id and name='Groomer' and deleted_at is null;
  if v_role is null then raise exception 'groomer_role_missing' using errcode = '22023'; end if;
  insert into public.memberships(organization_id,user_id,role_id,status)
  values(v_code.organization_id,v_actor,v_role,'active') returning id into v_membership;
  update public.resources set membership_id=v_membership
   where id=v_resource.id and organization_id=v_code.organization_id;
  update public.groomer_access_codes set claimed_at=now(), claimed_by=v_actor where id=v_code.id;
  return v_code.organization_id;
end;
$$;
revoke all on function app.issue_groomer_access_code(uuid), app.claim_groomer_access_code(text) from public, anon;
grant execute on function app.issue_groomer_access_code(uuid), app.claim_groomer_access_code(text) to authenticated;

-- This is intentionally platform-only and irrecoverable. The UI requires the
-- exact "HAPUS <slug>" confirmation. Related relational rows cascade and the
-- attachment objects are removed before the organization row is deleted.
create function app.delete_operro_organization(p_org uuid, p_confirmation text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_slug text;
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode='42501'; end if;
  select slug into v_slug from public.organizations where id=p_org for update;
  if not found then raise exception 'organization_not_found' using errcode='22023'; end if;
  if btrim(coalesce(p_confirmation,'')) <> ('HAPUS ' || v_slug) then
    raise exception 'delete_confirmation_mismatch' using errcode='22023';
  end if;
  delete from storage.objects where (bucket_id, name) in (
    select a.storage_bucket, a.storage_path from public.attachments a where a.organization_id=p_org
  );
  delete from public.organizations where id=p_org;
end;
$$;
revoke all on function app.delete_operro_organization(uuid,text) from public, anon;
grant execute on function app.delete_operro_organization(uuid,text) to authenticated;

create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101190000'::text;
$$;

notify pgrst, 'reload schema';
commit;
