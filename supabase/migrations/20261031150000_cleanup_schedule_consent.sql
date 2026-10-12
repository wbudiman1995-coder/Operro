-- P7: unattended storage cleanup - the DISABLED, owner-controlled state only (parity #43).
--
-- This repository has no scheduler and no service identity: no cron route, no vercel.json crons, no pg_cron job, no service-role
-- client, and the cleanup RPCs (20261029160000) deliberately act only inside a business owner's own session. An unattended
-- runner therefore needs two platform decisions that are NOT taken here (which scheduler; how it authenticates and is limited
-- to an organization that opted in). See docs/runbooks/UNATTENDED_CLEANUP.md.
--
-- What this migration adds is the part that must exist BEFORE any runner can be allowed to exist, and nothing that pretends to
-- run: a per-organization consent record that is OFF by default, can be switched off instantly by the owner, and is audited.
-- A future runner must read it and must also respect the existing run lease, dry-run-first rule, per-object retry and abandon
-- logic. Turning the consent on does not delete anything; the application states plainly that no runner exists.
begin;

create table public.storage_cleanup_schedules (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  cadence text not null default 'weekly' check (cadence in ('weekly','monthly')),
  changed_by uuid,
  changed_at timestamptz not null default now(),
  disabled_at timestamptz
);
create trigger trg_storage_cleanup_schedules_audit after insert or update or delete on public.storage_cleanup_schedules
  for each row execute function app.tg_write_audit();
alter table public.storage_cleanup_schedules enable row level security;
revoke all on public.storage_cleanup_schedules from public, anon, authenticated;
grant select on public.storage_cleanup_schedules to authenticated;
create policy storage_cleanup_schedules_owner_read on public.storage_cleanup_schedules for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership() and app.is_business_owner_member(organization_id)));

-- Business owner only. Disabling is immediate and unconditional; enabling records consent for the chosen cadence.
create function app.set_storage_cleanup_schedule(p_enabled boolean, p_cadence text default 'weekly') returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if v_org is null or not app.has_membership() or not app.is_business_owner_member(v_org) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_enabled is null or p_cadence is null or p_cadence not in ('weekly','monthly') then
    raise exception 'invalid_schedule' using errcode = '22023'; end if;
  perform 1 from public.organizations where id = v_org for update;
  insert into public.storage_cleanup_schedules(organization_id, enabled, cadence, changed_by, changed_at, disabled_at)
  values (v_org, p_enabled, p_cadence, app.fn_current_user_id(), now(), case when p_enabled then null else now() end)
  on conflict (organization_id) do update
     set enabled = excluded.enabled, cadence = excluded.cadence, changed_by = excluded.changed_by, changed_at = excluded.changed_at,
         disabled_at = case when excluded.enabled then null else coalesce(public.storage_cleanup_schedules.disabled_at, excluded.disabled_at) end;
end $$;

-- The state shown to the owner (and to health): consent only. It deliberately carries no "next run" because none exists.
create function app.storage_cleanup_schedule_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_row public.storage_cleanup_schedules;
begin
  if v_org is null or not app.has_membership() or not app.is_business_owner_member(v_org) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_row from public.storage_cleanup_schedules where organization_id = v_org;
  return jsonb_build_object(
    'enabled', coalesce(v_row.enabled, false), 'cadence', coalesce(v_row.cadence, 'weekly'),
    'changed_at', v_row.changed_at, 'disabled_at', v_row.disabled_at,
    'last_apply_at', (select max(r.started_at) from public.storage_cleanup_runs r where r.organization_id = v_org and r.mode = 'apply'),
    'last_apply_status', (select r.status from public.storage_cleanup_runs r where r.organization_id = v_org and r.mode = 'apply' order by r.started_at desc limit 1));
end $$;

revoke all on function app.set_storage_cleanup_schedule(boolean, text), app.storage_cleanup_schedule_state() from public, anon, authenticated;
grant execute on function app.set_storage_cleanup_schedule(boolean, text), app.storage_cleanup_schedule_state() to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261031150000'::text;
$$;

notify pgrst, 'reload schema';
commit;
