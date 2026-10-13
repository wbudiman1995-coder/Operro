-- Stream 3: the official WhatsApp provider boundary, disabled by default (parity #34).
--
-- Operro still sends nothing and still has no delivered/read state. This migration adds only the part that has to exist before an
-- official provider can ever be enabled, and makes enabling impossible until the platform decides:
--
--   * public.platform_flags: a platform-level switch table. The row 'whatsapp_provider_available' is seeded FALSE. There is
--     deliberately NO function that changes it: turning it on is an operator act (a reviewed migration or an operator SQL
--     statement) taken only after the decisions in docs/runbooks/WHATSAPP_PROVIDER_SETUP.md, never from the application.
--   * public.whatsapp_provider_settings: one row per organization with the NON-SECRET identifiers a provider needs (phone-number id,
--     business-account id) and the owner's attestation that customers consented to be messaged. No token, secret, password or URL
--     is ever stored here; credentials would live only in the hosting provider's secret store and are never read by the database.
--   * app.set_whatsapp_provider_settings: business owner only, optimistic concurrency, audited. It records the identifiers and the
--     attestation. `enabled = true` is refused with 'provider_not_available' while the platform flag is false.
--   * app.whatsapp_provider_state: what the owner sees, including whether the platform has made the provider available at all.
--
-- Nothing here is read by any sender, scheduler or webhook, because none exists. A webhook that records provider status would need a
-- service identity (see docs/agent-work/FINAL-PARITY-OPERATIONS-DESIGN.md, decision D7) and is not built.
begin;

create table public.platform_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,60}$'),
  enabled boolean not null default false,
  note text check (note is null or length(note) <= 300),
  updated_at timestamptz not null default now()
);
insert into public.platform_flags (key, enabled, note)
values ('whatsapp_provider_available', false, 'Seeded false. Enabling needs the provider, credential, consent, webhook and staging decisions in docs/runbooks/WHATSAPP_PROVIDER_SETUP.md.');
alter table public.platform_flags enable row level security;
revoke all on public.platform_flags from public, anon, authenticated;
grant select on public.platform_flags to authenticated;
create policy platform_flags_platform_read on public.platform_flags for select to authenticated using (app.is_operro_owner());

create function app.whatsapp_provider_available() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select f.enabled from public.platform_flags f where f.key = 'whatsapp_provider_available'), false);
$$;

create table public.whatsapp_provider_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null default 'none' check (provider in ('none','meta_cloud')),
  phone_number_id text check (phone_number_id is null or phone_number_id ~ '^[0-9]{5,20}$'),
  business_account_id text check (business_account_id is null or business_account_id ~ '^[0-9]{5,20}$'),
  consent_attested boolean not null default false,
  consent_attested_at timestamptz,
  consent_attested_by uuid,
  enabled boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint chk_whatsapp_provider_enabled check (not enabled or (provider <> 'none' and phone_number_id is not null and consent_attested)),
  constraint chk_whatsapp_provider_consent check (consent_attested = (consent_attested_at is not null))
);
create trigger trg_whatsapp_provider_settings_updated_at before update on public.whatsapp_provider_settings
  for each row execute function app.tg_set_updated_at();
create trigger trg_whatsapp_provider_settings_audit after insert or update or delete on public.whatsapp_provider_settings
  for each row execute function app.tg_write_audit();
alter table public.whatsapp_provider_settings enable row level security;
revoke all on public.whatsapp_provider_settings from public, anon, authenticated;
-- No direct client access at all: the owner reads through app.whatsapp_provider_state and writes through the RPC.

create function app.set_whatsapp_provider_settings(
  p_provider text, p_phone_number_id text, p_business_account_id text, p_consent_attested boolean, p_enabled boolean, p_expected_version integer
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_phone text := nullif(btrim(coalesce(p_phone_number_id, '')), '');
  v_waba text := nullif(btrim(coalesce(p_business_account_id, '')), '');
  v_row public.whatsapp_provider_settings;
  v_user uuid := app.fn_current_user_id();
begin
  if v_org is null or not app.has_membership() or not app.is_business_owner_member(v_org) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_provider not in ('none','meta_cloud') or p_consent_attested is null or p_enabled is null or p_expected_version is null
     or (v_phone is not null and v_phone !~ '^[0-9]{5,20}$') or (v_waba is not null and v_waba !~ '^[0-9]{5,20}$')
     or (p_provider = 'none' and (v_phone is not null or v_waba is not null or p_enabled)) then
    raise exception 'invalid_provider_settings' using errcode = '22023'; end if;
  if p_enabled and not app.whatsapp_provider_available() then
    raise exception 'provider_not_available' using errcode = '22023'; end if;
  if p_enabled and (v_phone is null or not p_consent_attested) then
    raise exception 'provider_prerequisites_missing' using errcode = '22023'; end if;

  select s.* into v_row from public.whatsapp_provider_settings s where s.organization_id = v_org for update;
  if not found then
    -- First write: the caller must have seen "no settings" (version 0).
    if p_expected_version <> 0 then raise exception 'stale_settings' using errcode = '40001'; end if;
    insert into public.whatsapp_provider_settings(organization_id, provider, phone_number_id, business_account_id, consent_attested, consent_attested_at, consent_attested_by, enabled, created_by, updated_by)
    values (v_org, p_provider, v_phone, v_waba, p_consent_attested, case when p_consent_attested then now() end, case when p_consent_attested then v_user end, p_enabled, v_user, v_user);
    return 1;
  end if;
  if v_row.version <> p_expected_version then raise exception 'stale_settings' using errcode = '40001'; end if;
  update public.whatsapp_provider_settings
     set provider = p_provider, phone_number_id = v_phone, business_account_id = v_waba, enabled = p_enabled, version = version + 1, updated_by = v_user,
         -- the attestation keeps its original time and person unless it is withdrawn or newly given
         consent_attested = p_consent_attested,
         consent_attested_at = case when not p_consent_attested then null when v_row.consent_attested then v_row.consent_attested_at else now() end,
         consent_attested_by = case when not p_consent_attested then null when v_row.consent_attested then v_row.consent_attested_by else v_user end
   where organization_id = v_org
   returning version into v_row.version;
  return v_row.version;
end $$;

create function app.whatsapp_provider_state()
returns table (
  platform_available boolean, provider text, phone_number_id text, business_account_id text,
  consent_attested boolean, consent_attested_at timestamptz, enabled boolean, version integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if v_org is null or not app.has_membership() or not app.is_business_owner_member(v_org) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  return query
  select app.whatsapp_provider_available(),
         coalesce(s.provider, 'none'), s.phone_number_id, s.business_account_id,
         coalesce(s.consent_attested, false), s.consent_attested_at,
         -- an organization row can say enabled only while the platform allows it
         coalesce(s.enabled, false) and app.whatsapp_provider_available(),
         coalesce(s.version, 0)
    from (select 1) one left join public.whatsapp_provider_settings s on s.organization_id = v_org;
end $$;

revoke all on function app.whatsapp_provider_available() from public, anon, authenticated;
revoke all on function app.set_whatsapp_provider_settings(text, text, text, boolean, boolean, integer) from public, anon, authenticated;
revoke all on function app.whatsapp_provider_state() from public, anon, authenticated;
grant execute on function app.set_whatsapp_provider_settings(text, text, text, boolean, boolean, integer) to authenticated;
grant execute on function app.whatsapp_provider_state() to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101120000'::text;
$$;

notify pgrst, 'reload schema';
commit;
