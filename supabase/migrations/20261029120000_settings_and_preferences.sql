-- E1.4 Business setting + personal default (parity #39, #42).
--
-- Organization-owned (shared by the whole business, owner-only writes):
--   organizations.settings.evidence_retention_days  -- already read by app.tg_apply_evidence_retention
--   (20260929100000). It had no safe write path; this adds one. It only affects evidence uploaded
--   AFTER the change: existing attachments keep the expires_at they were stamped with.
-- User-owned (follows the person across businesses, never visible to others):
--   public.user_preferences.landing_page -- the only personal default. Translation is out of scope.
--
-- The two are deliberately separate stores. The landing page is validated again at read time
-- against the caller's LIVE capabilities in the active organization, so a revoked capability,
-- a suspended membership or a different business silently falls back to 'dashboard'.
begin;

-- ---------------------------------------------------------------------------
-- Organization setting
-- ---------------------------------------------------------------------------
create function app.set_evidence_retention_days(p_days integer) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_settings jsonb;
begin
  if v_org is null or not app.has_membership() or not app.is_business_owner_member(v_org) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 30 and 1825 then
    raise exception 'invalid_evidence_retention' using errcode = '22023';
  end if;
  select settings into v_settings from public.organizations where id = v_org for update;
  if not found then raise exception 'not_authorized' using errcode = '42501'; end if;
  if jsonb_typeof(v_settings) is distinct from 'object' then v_settings := '{}'::jsonb; end if;
  update public.organizations
     set settings = v_settings || jsonb_build_object('evidence_retention_days', p_days)
   where id = v_org;
end $$;

-- ---------------------------------------------------------------------------
-- Personal default
-- ---------------------------------------------------------------------------
create table public.user_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  landing_page text check (landing_page in ('dashboard','schedule','customers','finance')),
  updated_at timestamptz not null default now()
);
create trigger trg_user_preferences_updated_at before update on public.user_preferences
  for each row execute function app.tg_set_updated_at();
alter table public.user_preferences enable row level security;
revoke all on public.user_preferences from public, anon, authenticated;
grant select on public.user_preferences to authenticated;
create policy user_preferences_own_read on public.user_preferences for select to authenticated
  using (user_id = app.fn_current_user_id());

-- Whether the landing key is openable by the caller right now, in the active organization.
create function app.landing_page_allowed(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_membership() and case p_key
    when 'dashboard' then true
    when 'schedule'  then app.has_permission('booking.read')
    when 'customers' then app.has_permission('customer.read')
    when 'finance'   then app.has_permission('finance.read')
    else false end;
$$;

create function app.set_my_landing_page(p_landing text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := app.fn_current_user_id();
begin
  if v_user is null or not app.has_membership() then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_landing is not null and p_landing not in ('dashboard','schedule','customers','finance') then
    raise exception 'invalid_landing_page' using errcode = '22023'; end if;
  if p_landing is not null and not app.landing_page_allowed(p_landing) then
    raise exception 'landing_page_not_permitted' using errcode = '42501'; end if;
  insert into public.user_preferences(user_id, landing_page) values (v_user, p_landing)
  on conflict (user_id) do update set landing_page = excluded.landing_page;
end $$;

-- The key to open for the caller in the active organization; 'dashboard' whenever nothing valid is saved.
create function app.my_landing_page() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_key text;
begin
  if app.fn_current_user_id() is null then return 'dashboard'; end if;
  select landing_page into v_key from public.user_preferences where user_id = app.fn_current_user_id();
  if v_key is not null and app.landing_page_allowed(v_key) then return v_key; end if;
  return 'dashboard';
end $$;

revoke all on function app.set_evidence_retention_days(integer), app.landing_page_allowed(text),
  app.set_my_landing_page(text), app.my_landing_page() from public, anon, authenticated;
grant execute on function app.set_evidence_retention_days(integer), app.set_my_landing_page(text),
  app.my_landing_page() to authenticated;

-- Make the new RPCs visible to PostgREST without waiting for its schema-cache refresh.
notify pgrst, 'reload schema';
commit;
