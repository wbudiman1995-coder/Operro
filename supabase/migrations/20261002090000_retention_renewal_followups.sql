-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20261002090000_retention_renewal_followups
-- Section          35 -- retention/renewal follow-up queues
-- Purpose          Authoritative last-groomed timestamp, configurable
--                   inactivity threshold, paginated overdue-pet and
--                   renewal queues (SECURITY DEFINER, real branch/tenant
--                   authorization), and a narrowly-scoped follow-up/renewal
--                   message-template settings slice.
--
-- SECTION 1 -- grooming_job_pets.completed_at
-- ---------------------------------------------------------------------
-- `updated_at` cannot serve as "the moment this pet's grooming finished":
-- the existing `trg_gjp_updated_at` trigger re-stamps it on ANY later edit
-- to the row (e.g. a groomer editing `instructions` after completion),
-- which would silently move a pet's last-groomed date forward with no
-- new service actually rendered. `completed_at` is the first and only
-- authoritative capture of that instant, stamped exactly once when status
-- transitions INTO 'complete' and cleared if it is ever transitioned back
-- out (so a later re-completion gets a fresh, correct timestamp).
--
-- Documented legacy fallback: rows already 'complete' before this
-- migration have no such instant on record. They are backfilled to their
-- current `updated_at` -- the best available approximation, and the only
-- one that ever existed for these rows -- not a synthesized guess.
-- =====================================================================
begin;

alter table public.grooming_job_pets add column completed_at timestamptz;

create or replace function app.tg_gjp_stamp_completed_at()
returns trigger language plpgsql as $$
begin
  if new.status = 'complete' and (tg_op = 'INSERT' or old.status is distinct from 'complete') then
    new.completed_at := now();
  elsif new.status <> 'complete' then
    new.completed_at := null;
  end if;
  return new;
end; $$;

create trigger trg_gjp_stamp_completed_at before insert or update on public.grooming_job_pets
  for each row execute function app.tg_gjp_stamp_completed_at();

-- Legacy backfill (documented fallback -- see manifest above).
update public.grooming_job_pets
   set completed_at = updated_at
 where status = 'complete' and completed_at is null;


-- =====================================================================
-- SECTION 2 -- organizations: followup_retention settings backfill
-- ---------------------------------------------------------------------
-- `organizations` deliberately never carries the generic `trg_write_audit`
-- trigger (see its own original comment: "no organization_id"). Tried
-- attaching it here first; it broke the seed script, because seeding
-- inserts organization rows outside any authenticated session, so
-- `app.tg_write_audit`'s own fallback -- `app.fn_active_organization()`,
-- which resolves from JWT claims -- returns NULL there, violating
-- `audit_log.organization_id`'s NOT NULL constraint. A blanket trigger on
-- every future write to this root tenant table (seeds, migrations,
-- platform tooling, not just this module's own RPC) is the wrong blast
-- radius for one settings write. `app.update_followup_retention_settings`
-- below instead writes its own explicit audit_log row, inside the one RPC
-- that actually has a real authenticated actor and active org -- audit
-- reuse scoped to what this module actually touches, not a table-wide
-- change with a real failure mode already caught by running it for real.
--
-- Preserve current behavior for every organization that exists as of this
-- migration: explicit 30-day threshold, merged into `settings` without
-- touching any other key (branding, bank accounts, payroll, etc. all live
-- in the same jsonb column). Organizations created after this migration
-- that never receive an explicit value read HomePaw's verified 14-day
-- default at query time (see app.fn_followup_retention_settings below) --
-- this one-time backfill is what makes "explicit 30" vs "implicit 14"
-- distinguishable going forward without touching the signup path.
update public.organizations
   set settings = settings || jsonb_build_object(
         'followup_retention', jsonb_build_object('inactivity_threshold_days', 30))
 where settings -> 'followup_retention' -> 'inactivity_threshold_days' is null;

commit;


-- =====================================================================
-- SECTION 3 -- followup_retention settings: read helper + guarded write
-- ---------------------------------------------------------------------
-- Read is intentionally NOT permission-gated beyond ordinary org
-- membership (the existing `organizations_read` RLS policy already lets
-- any active member of the org read the whole `organizations` row,
-- including `settings`) -- the S35 brief only requires WRITE to be
-- restricted ("Show the effective setting in the page" to any viewer;
-- only settings.manage may change it). Write reuses the existing
-- `settings.manage` permission (already seeded, already the permission
-- `organizations_write` RLS itself requires) and merges only the
-- `followup_retention` key via `settings || jsonb_build_object(...)`, so a
-- concurrent branding/bank-account/payroll settings write is untouched.
--
-- No dedicated revision column exists on `organizations`. The narrow
-- concurrency guard this module adds compares the caller's
-- previously-read `updated_at` against the current row's `updated_at`
-- under `for update` lock, exactly the same class of guard as the
-- membership correction RPCs' `revision` check, just keyed to the column
-- that actually exists on this table.
-- =====================================================================
begin;

create or replace function app.fn_followup_retention_settings(p_org uuid)
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'inactivity_threshold_days', coalesce((o.settings -> 'followup_retention' ->> 'inactivity_threshold_days')::integer, 14),
    'followup_template', coalesce(o.settings -> 'followup_retention' ->> 'followup_template',
      'Hai Kak {nama}, sudah {days} hari sejak grooming terakhir untuk {dogs}. Apakah ingin menjadwalkan grooming berikutnya bersama {biz}?'),
    'renewal_template', coalesce(o.settings -> 'followup_retention' ->> 'renewal_template',
      'Hai Kak {nama}, berikut estimasi perpanjangan paket {tier} untuk {dogs}: {amount}. Silakan konfirmasi kepada {biz} untuk melanjutkan.'),
    'updated_at', o.updated_at
  )
  from public.organizations o where o.id = p_org;
$$;

revoke all on function app.fn_followup_retention_settings(uuid) from public, authenticated;
grant execute on function app.fn_followup_retention_settings(uuid) to authenticated;

create or replace function app.get_followup_retention_settings()
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare v_org uuid;
begin
  v_org := app.fn_active_organization();
  if v_org is null or not app.has_membership() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return app.fn_followup_retention_settings(v_org);
end; $$;

revoke all on function app.get_followup_retention_settings() from public, authenticated;
grant execute on function app.get_followup_retention_settings() to authenticated;

-- Known placeholder tokens per template (S35 brief). Unknown tokens fail
-- the save with a useful message rather than being silently stored and
-- later rendered as a literal, un-interpolated "{typo}" in a real draft.
create or replace function app.fn_validate_template_placeholders(p_template text, p_allowed text[])
returns text
language plpgsql immutable as $$
declare v_token text; v_unknown text[] := '{}';
begin
  for v_token in select (regexp_matches(p_template, '\{([a-zA-Z_]+)\}', 'g'))[1] loop
    if not (v_token = any(p_allowed)) then
      v_unknown := array_append(v_unknown, v_token);
    end if;
  end loop;
  if array_length(v_unknown, 1) > 0 then
    return 'unknown_placeholder:' || array_to_string(v_unknown, ',');
  end if;
  return null;
end; $$;

create or replace function app.update_followup_retention_settings(
  p_expected_updated_at timestamptz,
  p_inactivity_threshold_days integer,
  p_followup_template text,
  p_renewal_template text
) returns jsonb
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid; v_row public.organizations; v_error text;
begin
  v_org := app.fn_active_organization();
  perform app.assert_tenant_authorized(v_org, null, 'settings.manage');

  select * into v_row from public.organizations where id = v_org for update;
  if not found then raise exception 'organization_not_found' using errcode = 'no_data_found'; end if;
  if p_expected_updated_at is null or v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_settings_write' using errcode = '40001';
  end if;

  if p_inactivity_threshold_days is null or p_inactivity_threshold_days < 1 or p_inactivity_threshold_days > 365 then
    raise exception 'invalid_inactivity_threshold' using errcode = '22023';
  end if;
  if p_followup_template is null or length(btrim(p_followup_template)) = 0
     or p_renewal_template is null or length(btrim(p_renewal_template)) = 0 then
    raise exception 'template_required' using errcode = '22023';
  end if;

  v_error := app.fn_validate_template_placeholders(p_followup_template, array['nama','dogs','days','inactive_period','biz']);
  if v_error is not null then raise exception '%', v_error using errcode = '22023'; end if;
  v_error := app.fn_validate_template_placeholders(p_renewal_template, array['nama','dogs','tier','amount','due_day','biz']);
  if v_error is not null then raise exception '%', v_error using errcode = '22023'; end if;

  update public.organizations
     set settings = settings || jsonb_build_object('followup_retention', jsonb_build_object(
           'inactivity_threshold_days', p_inactivity_threshold_days,
           'followup_template', p_followup_template,
           'renewal_template', p_renewal_template))
   where id = v_org;

  insert into app.audit_log (organization_id, actor_id, action, entity_table, entity_id, diff)
  values (v_org, app.fn_current_user_id(), 'UPDATE', 'organizations', v_org,
          jsonb_build_object(
            'old', jsonb_build_object('followup_retention', v_row.settings -> 'followup_retention'),
            'new', jsonb_build_object('followup_retention', jsonb_build_object(
                     'inactivity_threshold_days', p_inactivity_threshold_days,
                     'followup_template', p_followup_template, 'renewal_template', p_renewal_template))));

  return app.fn_followup_retention_settings(v_org);
end; $$;

revoke all on function app.update_followup_retention_settings(timestamptz, integer, text, text) from public, authenticated;
grant execute on function app.update_followup_retention_settings(timestamptz, integer, text, text) to authenticated;

commit;


-- =====================================================================
-- SECTION 4 -- app.list_overdue_customers: paginated, branch-authorized
-- ---------------------------------------------------------------------
-- Last-groomed source of truth: grooming_job_pets.status = 'complete'
-- directly (never gated on the parent booking's own status = 'completed'
-- -- a sibling pet still in flight on the same booking must not hide a
-- pet that is itself already done). Canceled/no-show/deleted bookings are
-- excluded; multiple service lines on one visit collapse to one visit
-- (grouped by pet_id, not by service line, so a multi-service visit never
-- inflates visit counts or produces duplicate reminder lines).
--
-- Calendar-day inactivity uses the same convention as the TS-side
-- `zonedDaysBetween` helper (`apps/web/src/lib/timezone.ts`): a calendar
-- DATE subtraction inside the business timezone, never a UTC/24h elapsed
-- division. Asia/Jakarta is hardcoded here exactly as it already is in
-- `membership-correction.ts`'s MEMBERSHIP_TIMEZONE -- this app has one
-- supported business timezone, not a second convention.
--
-- Branch authorization is mandatory, not merely a UI filter: a caller
-- without `branches.all` only ever sees visits/upcoming bookings at
-- branches `app.has_branch` grants them, regardless of what `p_branch` is
-- passed. A restricted caller whose pet's only real visit is at an
-- inaccessible branch sees that pet as having no visit in ITS accessible
-- scope (surfaced by the caller as "no grooming recorded in your
-- accessible branches", never as bare "never groomed", which would be a
-- false claim about branches the caller cannot see).
-- =====================================================================
begin;

create or replace function app.list_overdue_customers(
  p_branch uuid default null,
  p_search text default null,
  p_filter text default 'default',
  p_page integer default 1,
  p_page_size integer default 25
) returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_org uuid; v_threshold integer; v_all_branches boolean;
  v_page integer; v_page_size integer; v_search text; v_total integer;
  v_groups jsonb;
begin
  v_org := app.fn_active_organization();
  perform app.assert_tenant_authorized(v_org, 'crm', null);
  perform app.assert_tenant_authorized(v_org, 'scheduling', 'booking.read');

  if p_branch is not null and not app.has_branch(p_branch) then
    raise exception 'branch_not_accessible' using errcode = 'insufficient_privilege';
  end if;
  if p_filter not in ('default','without_upcoming','never_groomed') then
    raise exception 'invalid_filter' using errcode = '22023';
  end if;

  v_all_branches := app.has_permission('branches.all');
  v_page := greatest(1, coalesce(p_page, 1));
  v_page_size := least(100, greatest(1, coalesce(p_page_size, 25)));
  v_search := nullif(btrim(coalesce(p_search, '')), '');

  select coalesce((o.settings -> 'followup_retention' ->> 'inactivity_threshold_days')::integer, 14)
    into v_threshold from public.organizations o where o.id = v_org;

  -- No temp table: this is a `stable` function that a single test/browser
  -- session may call repeatedly inside one transaction, and a temp table
  -- created ON COMMIT DROP would collide with itself on the second call.
  -- `filtered_pets` is therefore recomputed (not materialized) by each of
  -- the two statements below; both copies must stay identical so the
  -- returned `total_groups` always matches the same rows as `groups`.
  with visits as (
    select gjp.pet_id, gjp.completed_at, b.branch_id
    from public.grooming_job_pets gjp
    join public.bookings b on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
    where gjp.organization_id = v_org and gjp.status = 'complete' and gjp.deleted_at is null
      and b.deleted_at is null and b.status not in ('canceled', 'no_show')
      and (v_all_branches or app.has_branch(b.branch_id))
      and (p_branch is null or b.branch_id = p_branch)
  ),
  last_visit as (
    select pet_id,
           max(completed_at) filter (where completed_at <= now()) as last_at,
           bool_or(completed_at > now()) as has_future_anomaly
    from visits group by pet_id
  ),
  upcoming as (
    select distinct gjp.pet_id
    from public.grooming_job_pets gjp
    join public.bookings b on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
    where gjp.organization_id = v_org and gjp.deleted_at is null
      and b.deleted_at is null and b.status not in ('canceled', 'no_show') and b.ends_at > now()
      and (v_all_branches or app.has_branch(b.branch_id))
  ),
  eligible as (
    select p.id as pet_id, p.customer_id, p.name as pet_name, c.display_name as customer_name, c.phone,
           lv.last_at, coalesce(lv.has_future_anomaly, false) as has_future_anomaly,
           case when lv.last_at is not null
                then ((now() at time zone 'Asia/Jakarta')::date - (lv.last_at at time zone 'Asia/Jakarta')::date)
                else null end as days_since,
           (u.pet_id is not null) as has_upcoming
    from public.pets p
    join public.customers c on c.organization_id = p.organization_id and c.id = p.customer_id
    left join last_visit lv on lv.pet_id = p.id
    left join upcoming u on u.pet_id = p.id
    where p.organization_id = v_org and p.status = 'active' and p.deleted_at is null
      and (v_search is null or p.name ilike '%' || v_search || '%' or c.display_name ilike '%' || v_search || '%')
  ),
  filtered_pets as (
    select * from eligible ep
    where (
      case p_filter
        when 'never_groomed' then ep.last_at is null
        else ep.last_at is not null and ep.days_since >= v_threshold
      end
      and (p_filter <> 'without_upcoming' or not ep.has_upcoming)
    )
  )
  select count(distinct customer_id) into v_total from filtered_pets;

  with visits as (
    select gjp.pet_id, gjp.completed_at, b.branch_id
    from public.grooming_job_pets gjp
    join public.bookings b on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
    where gjp.organization_id = v_org and gjp.status = 'complete' and gjp.deleted_at is null
      and b.deleted_at is null and b.status not in ('canceled', 'no_show')
      and (v_all_branches or app.has_branch(b.branch_id))
      and (p_branch is null or b.branch_id = p_branch)
  ),
  last_visit as (
    select pet_id,
           max(completed_at) filter (where completed_at <= now()) as last_at,
           bool_or(completed_at > now()) as has_future_anomaly
    from visits group by pet_id
  ),
  upcoming as (
    select distinct gjp.pet_id
    from public.grooming_job_pets gjp
    join public.bookings b on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
    where gjp.organization_id = v_org and gjp.deleted_at is null
      and b.deleted_at is null and b.status not in ('canceled', 'no_show') and b.ends_at > now()
      and (v_all_branches or app.has_branch(b.branch_id))
  ),
  eligible as (
    select p.id as pet_id, p.customer_id, p.name as pet_name, c.display_name as customer_name, c.phone,
           lv.last_at, coalesce(lv.has_future_anomaly, false) as has_future_anomaly,
           case when lv.last_at is not null
                then ((now() at time zone 'Asia/Jakarta')::date - (lv.last_at at time zone 'Asia/Jakarta')::date)
                else null end as days_since,
           (u.pet_id is not null) as has_upcoming
    from public.pets p
    join public.customers c on c.organization_id = p.organization_id and c.id = p.customer_id
    left join last_visit lv on lv.pet_id = p.id
    left join upcoming u on u.pet_id = p.id
    where p.organization_id = v_org and p.status = 'active' and p.deleted_at is null
      and (v_search is null or p.name ilike '%' || v_search || '%' or c.display_name ilike '%' || v_search || '%')
  ),
  filtered_pets as (
    select * from eligible ep
    where (
      case p_filter
        when 'never_groomed' then ep.last_at is null
        else ep.last_at is not null and ep.days_since >= v_threshold
      end
      and (p_filter <> 'without_upcoming' or not ep.has_upcoming)
    )
  ),
  customer_order as (
    select customer_id, max(days_since) as max_days
    from filtered_pets group by customer_id
    order by max_days desc nulls last, customer_id
    limit v_page_size offset (v_page - 1) * v_page_size
  ),
  ranked_pets as (
    select fp.*, row_number() over (partition by fp.customer_id order by fp.days_since desc nulls last, fp.pet_id) as rn,
           count(*) over (partition by fp.customer_id) as pet_count
    from filtered_pets fp
    join customer_order co on co.customer_id = fp.customer_id
  )
  select coalesce(jsonb_agg(g.obj order by g.max_days desc nulls last, g.customer_id), '[]'::jsonb) into v_groups
  from (
    select rp.customer_id, max(co.max_days) as max_days,
      jsonb_build_object(
        'customer_id', rp.customer_id, 'customer_name', min(rp.customer_name), 'phone', min(rp.phone),
        'pets_total', min(rp.pet_count), 'pets_truncated_count', greatest(0, min(rp.pet_count) - 20),
        'pets', jsonb_agg(jsonb_build_object(
          'pet_id', rp.pet_id, 'pet_name', rp.pet_name,
          'last_groomed_at', rp.last_at, 'days_since', rp.days_since,
          'has_upcoming_booking', rp.has_upcoming, 'anomaly_future_dated', rp.has_future_anomaly
        ) order by rp.days_since desc nulls last, rp.pet_id) filter (where rp.rn <= 20)
      ) as obj
    from ranked_pets rp
    join customer_order co on co.customer_id = rp.customer_id
    group by rp.customer_id
  ) g;

  return jsonb_build_object(
    'groups', v_groups, 'total_groups', v_total, 'page', v_page, 'page_size', v_page_size,
    'threshold_days', v_threshold, 'filter', p_filter
  );
end; $$;

revoke all on function app.list_overdue_customers(uuid, text, text, integer, integer) from public, authenticated;
grant execute on function app.list_overdue_customers(uuid, text, text, integer, integer) to authenticated;

commit;


-- =====================================================================
-- SECTION 5 -- app.list_renewal_queue: paginated, membership.read-gated
-- ---------------------------------------------------------------------
-- Reuses the same authorization `preview_package_renewal` already applies
-- (`membership` module + `membership.read`) -- a viewer who can already
-- read a real renewal preview can read this summary list; no permission is
-- weakened or newly granted. Amounts are NOT computed here (this function
-- never touches `packages.price`) -- the brief is explicit that only the
-- existing preview RPC may price a renewal, so this list intentionally
-- carries no price field; the UI calls `previewPackageRenewalAction` for
-- one selected membership at a time, on demand.
--
-- `held`/`available`/`consumed` reuse the same ledger-derived formula as
-- `preview_package_renewal` (available = sessions_remaining - reserved);
-- `consumed` is summed straight from the immutable ledger, never inferred
-- as `total - available` (that would misreport reserved-but-unconsumed
-- sessions as consumed -- exactly the F07 failure mode named in the brief).
-- =====================================================================
begin;

create or replace function app.list_renewal_queue(
  p_view text default 'actionable',
  p_search text default null,
  p_include_tokens boolean default false,
  p_page integer default 1,
  p_page_size integer default 25
) returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_org uuid; v_page integer; v_page_size integer; v_search text; v_total integer; v_groups jsonb;
begin
  v_org := app.fn_active_organization();
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.read');

  if p_view not in ('actionable', 'historical', 'all') then
    raise exception 'invalid_view' using errcode = '22023';
  end if;
  v_page := greatest(1, coalesce(p_page, 1));
  v_page_size := least(100, greatest(1, coalesce(p_page_size, 25)));
  v_search := nullif(btrim(coalesce(p_search, '')), '');

  with reserved as (
    select customer_package_id, count(*) as reserved_count
    from public.package_reservations
    where organization_id = v_org and status = 'reserved'
    group by customer_package_id
  ),
  consumed as (
    select customer_package_id, sum(-delta) as consumed_count
    from public.customer_package_ledger
    where organization_id = v_org and reason = 'consumption'
    group by customer_package_id
  ),
  eligible as (
    select cp.id, cp.customer_id, c.display_name as customer_name, c.phone,
           pt.name as pet_name, sc.name as service_name, pk.name as package_name,
           pk.recurrence_interval, (pk.recurrence_interval <> 'none') as is_recurring,
           cp.status, cp.expires_at, cp.sessions_remaining,
           coalesce(r.reserved_count, 0) as reserved_count, coalesce(k.consumed_count, 0) as consumed_count,
           greatest(0, cp.sessions_remaining - coalesce(r.reserved_count, 0)) as available_count
    from public.customer_packages cp
    join public.packages pk on pk.organization_id = cp.organization_id and pk.id = cp.package_id
    join public.customers c on c.organization_id = cp.organization_id and c.id = cp.customer_id
    left join public.pets pt on pt.organization_id = cp.organization_id and pt.id = cp.pet_id
    left join public.service_catalog sc on sc.organization_id = cp.organization_id and sc.id = cp.service_id
    left join reserved r on r.customer_package_id = cp.id
    left join consumed k on k.customer_package_id = cp.id
    where cp.organization_id = v_org and cp.deleted_at is null
      and (p_include_tokens or pk.recurrence_interval <> 'none')
      and (case p_view
             when 'historical' then cp.status = 'canceled'
             when 'actionable' then cp.status <> 'canceled'
             else true
           end)
      and (v_search is null or c.display_name ilike '%' || v_search || '%' or pt.name ilike '%' || v_search || '%' or pk.name ilike '%' || v_search || '%')
  )
  select count(distinct customer_id) into v_total from eligible;

  with reserved as (
    select customer_package_id, count(*) as reserved_count
    from public.package_reservations
    where organization_id = v_org and status = 'reserved'
    group by customer_package_id
  ),
  consumed as (
    select customer_package_id, sum(-delta) as consumed_count
    from public.customer_package_ledger
    where organization_id = v_org and reason = 'consumption'
    group by customer_package_id
  ),
  eligible as (
    select cp.id, cp.customer_id, c.display_name as customer_name, c.phone,
           pt.name as pet_name, sc.name as service_name, pk.name as package_name,
           pk.recurrence_interval, (pk.recurrence_interval <> 'none') as is_recurring,
           cp.status, cp.expires_at, cp.sessions_remaining,
           coalesce(r.reserved_count, 0) as reserved_count, coalesce(k.consumed_count, 0) as consumed_count,
           greatest(0, cp.sessions_remaining - coalesce(r.reserved_count, 0)) as available_count
    from public.customer_packages cp
    join public.packages pk on pk.organization_id = cp.organization_id and pk.id = cp.package_id
    join public.customers c on c.organization_id = cp.organization_id and c.id = cp.customer_id
    left join public.pets pt on pt.organization_id = cp.organization_id and pt.id = cp.pet_id
    left join public.service_catalog sc on sc.organization_id = cp.organization_id and sc.id = cp.service_id
    left join reserved r on r.customer_package_id = cp.id
    left join consumed k on k.customer_package_id = cp.id
    where cp.organization_id = v_org and cp.deleted_at is null
      and (p_include_tokens or pk.recurrence_interval <> 'none')
      and (case p_view
             when 'historical' then cp.status = 'canceled'
             when 'actionable' then cp.status <> 'canceled'
             else true
           end)
      and (v_search is null or c.display_name ilike '%' || v_search || '%' or pt.name ilike '%' || v_search || '%' or pk.name ilike '%' || v_search || '%')
  ),
  ranked as (
    select e.*,
      (e.expires_at is not null and e.expires_at < now()) as is_expired,
      (e.expires_at is not null and e.expires_at >= now()
        and ((e.expires_at at time zone 'Asia/Jakarta')::date - (now() at time zone 'Asia/Jakarta')::date) <= 7) as is_expiring_soon,
      (e.available_count = 0 and e.reserved_count = 0) as no_available_sessions,
      (e.available_count = 0 and e.reserved_count > 0) as all_reserved,
      (e.available_count = 1) as one_available
    from eligible e
  ),
  customer_order as (
    select customer_id, min(customer_name) as customer_name
    from ranked group by customer_id
    order by customer_name, customer_id
    limit v_page_size offset (v_page - 1) * v_page_size
  ),
  scoped as (
    select r.* from ranked r join customer_order co on co.customer_id = r.customer_id
  )
  select coalesce(jsonb_agg(g.obj order by g.customer_name, g.customer_id), '[]'::jsonb) into v_groups
  from (
    select s.customer_id, min(s.customer_name) as customer_name,
      jsonb_build_object(
        'customer_id', s.customer_id, 'customer_name', min(s.customer_name), 'phone', min(s.phone),
        'memberships', jsonb_agg(jsonb_build_object(
          'id', s.id, 'pet_name', s.pet_name, 'service_name', s.service_name, 'package_name', s.package_name,
          'recurrence_interval', s.recurrence_interval, 'is_recurring', s.is_recurring, 'status', s.status,
          'expires_at', s.expires_at, 'sessions_remaining', s.sessions_remaining,
          'reserved_count', s.reserved_count, 'consumed_count', s.consumed_count, 'available_count', s.available_count,
          'is_expired', s.is_expired, 'is_expiring_soon', s.is_expiring_soon,
          'no_available_sessions', s.no_available_sessions, 'all_reserved', s.all_reserved, 'one_available', s.one_available
        ) order by s.expires_at nulls last, s.id)
      ) as obj
    from scoped s
    group by s.customer_id
  ) g;

  return jsonb_build_object('groups', v_groups, 'total_groups', v_total, 'page', v_page, 'page_size', v_page_size, 'view', p_view);
end; $$;

revoke all on function app.list_renewal_queue(text, text, boolean, integer, integer) from public, authenticated;
grant execute on function app.list_renewal_queue(text, text, boolean, integer, integer) to authenticated;

commit;
