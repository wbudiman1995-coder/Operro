-- P5: business configuration - calendar working hours per branch (HomePaw "hours" open/close, parity #39).
--
-- Mapping of HomePaw's configuration object to Operro (see docs/handoffs/CLAUDE-FINAL-PARITY-CLOSEOUT-HANDOFF.md):
-- almost every HomePaw key already has an authoritative Operro home with its own validated RPC. The one that was read by the
-- application but had NO write path is branches.settings.schedule.{dayStartMinutes,dayEndMinutes}, which bounds the calendar
-- time axis (apps/web/src/lib/schedule.ts readConfiguredHours). This migration adds a typed RPC for exactly those two keys.
--
-- It is not a settings editor: two integers, quarter-hour steps, a minimum span, an optimistic-concurrency token (the
-- branch's updated_at), sibling settings preserved, and the existing audit trigger on branches records every change. The
-- hours only size the displayed time axis; bookings outside them stay visible (resolveMinuteBounds widens to fit) and
-- availability / slot recommendations are untouched.
--
-- Authority: the business owner, or a member holding branches.manage who can access that branch (the capability the owner
-- delegates; the same gate as the branch table's own write policy, plus the branch grant the policy does not check).
begin;

create function app.set_branch_calendar_hours(p_branch uuid, p_start_minutes integer, p_end_minutes integer, p_expected_updated_at timestamptz)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_branch public.branches;
  v_settings jsonb;
  v_schedule jsonb;
  v_updated timestamptz;
begin
  if v_org is null or not app.has_membership() or p_branch is null then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if not (app.is_business_owner_member(v_org) or (app.has_permission('branches.manage') and app.has_branch(p_branch))) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if (p_start_minutes is null) <> (p_end_minutes is null)
     or (p_start_minutes is not null and (
          p_start_minutes not between 0 and 1320 or p_end_minutes not between 120 and 1440
          or p_start_minutes % 15 <> 0 or p_end_minutes % 15 <> 0 or p_end_minutes - p_start_minutes < 120)) then
    raise exception 'invalid_hours' using errcode = '22023'; end if;
  if p_expected_updated_at is null then raise exception 'invalid_hours' using errcode = '22023'; end if;

  select b.* into v_branch from public.branches b
   where b.organization_id = v_org and b.id = p_branch and b.deleted_at is null for update;
  if not found then raise exception 'branch_not_found' using errcode = 'P0002'; end if;
  if v_branch.updated_at is distinct from p_expected_updated_at then raise exception 'stale_branch' using errcode = '40001'; end if;

  v_settings := case when jsonb_typeof(v_branch.settings) = 'object' then v_branch.settings else '{}'::jsonb end;
  v_schedule := case when jsonb_typeof(v_settings -> 'schedule') = 'object' then v_settings -> 'schedule' else '{}'::jsonb end;
  if p_start_minutes is null then
    -- reset to the application defaults: drop only the two keys, keep every other key
    v_schedule := (v_schedule - 'dayStartMinutes') - 'dayEndMinutes';
  else
    v_schedule := v_schedule || jsonb_build_object('dayStartMinutes', p_start_minutes, 'dayEndMinutes', p_end_minutes);
  end if;
  v_settings := case when v_schedule = '{}'::jsonb then v_settings - 'schedule' else v_settings || jsonb_build_object('schedule', v_schedule) end;

  update public.branches set settings = v_settings where id = p_branch returning updated_at into v_updated;
  return v_updated;
end $$;

revoke all on function app.set_branch_calendar_hours(uuid, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function app.set_branch_calendar_hours(uuid, integer, integer, timestamptz) to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261031140000'::text;
$$;

notify pgrst, 'reload schema';
commit;
