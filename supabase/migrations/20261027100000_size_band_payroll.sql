-- Dynamic tenant-owned size bands, Bundle 4 (SB-06): payroll adaptation.
--
-- Payroll rate matrices (payroll_cycle_settings.per_pet_size_matrix_default and
-- staff_payroll_settings.per_pet_size_matrix) become keyed by the organization's
-- own dog size-band keys instead of the four hard-coded keys.
--
-- Decision O4 (live pet sizing for draft calculations, frozen results after):
--   * app.compute_payroll_item resolves each dog's size through the existing
--     authoritative path app.pet_pricing_key (weight -> active band, stored size
--     only when it is an active band). No caller supplies a key, label, org or
--     amount, and there is no TypeScript copy of the rule.
--   * Only draft recomputes call compute_payroll_item. approved/paid payroll_items
--     keep the breakdown they were frozen with; nothing here updates, rewrites or
--     deletes payroll_runs/payroll_items/booking/invoice/package snapshots.
--   * New draft breakdowns gain an ADDITIVE `perDogDetail` array
--     [{key,label,count,rate,amount}] so the frozen result stays self-explaining
--     after a band is renamed, re-banded or archived. Existing keys are unchanged.
--
-- Unchanged on purpose: cats and custom species have no payroll size (flat rate,
-- as before); unmeasured dogs with no active stored size use the flat rate; a
-- band with no matrix entry (or a NULL entry) falls back to the flat rate; a
-- staff matrix still replaces the organization matrix as a whole object.
begin;

-- ---------------------------------------------------------------------------
-- Single payroll sizing rule. Dogs only: the existing payroll model never paid
-- by size for any other species. Internal -- never granted to a client role.
-- ---------------------------------------------------------------------------
create function app.payroll_pet_size_key(p_org uuid, p_species text, p_weight numeric, p_stored_size text)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_species = 'dog'
              then app.pet_pricing_key(p_org, p_species, p_weight, p_stored_size) end;
$$;

-- ---------------------------------------------------------------------------
-- Matrix validation. A key may be added or its rate changed only for an ACTIVE
-- dog band of the row's own organization, so another tenant's keys, unknown keys
-- and archived keys are refused. A key whose rate is unchanged from the stored
-- row is accepted as-is (grandfathered): saving an unrelated column, or an
-- organization that later archived a band, never invalidates existing data and
-- no existing matrix is rewritten by this migration. A NULL rate stays valid (the
-- calculation falls back to the flat rate for that size).
-- ---------------------------------------------------------------------------
create function app.tg_validate_payroll_size_matrix() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_col text := case tg_table_name when 'payroll_cycle_settings' then 'per_pet_size_matrix_default'
                                   else 'per_pet_size_matrix' end;
  v_new jsonb := to_jsonb(new) -> v_col;
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) -> v_col end;
  e record;
begin
  if v_new is null or jsonb_typeof(v_new) = 'null' then return new; end if;
  -- INSERT ... ON CONFLICT DO UPDATE fires the BEFORE INSERT trigger on the
  -- proposed row first, so an upsert of an existing row compares to the stored one.
  if tg_op = 'INSERT' then
    if tg_table_name = 'payroll_cycle_settings' then
      select s.per_pet_size_matrix_default into v_old
      from public.payroll_cycle_settings s where s.organization_id = new.organization_id;
    else
      select s.per_pet_size_matrix into v_old
      from public.staff_payroll_settings s
      where s.organization_id = new.organization_id and s.membership_id = new.membership_id;
    end if;
  end if;
  if jsonb_typeof(v_new) <> 'object' then
    raise exception 'payroll_size_matrix_invalid' using errcode = '22023'; end if;
  for e in select k.key, k.value from jsonb_each(v_new) k loop
    if v_old is not null and jsonb_typeof(v_old) = 'object'
       and (v_old -> e.key) is not distinct from e.value then
      continue;
    end if;
    if not exists (select 1 from public.organization_size_bands b
                   where b.organization_id = new.organization_id and b.band_key = e.key
                     and b.band_kind = 'dog_weight' and b.status = 'active') then
      raise exception 'payroll_size_key_invalid:%', e.key using errcode = '22023'; end if;
    if jsonb_typeof(e.value) not in ('number', 'null')
       or (jsonb_typeof(e.value) = 'number' and ((e.value #>> '{}')::numeric < 0
                                                  or (e.value #>> '{}')::numeric >= 1000000000000)) then
      raise exception 'payroll_size_rate_invalid:%', e.key using errcode = '22023'; end if;
  end loop;
  return new;
end $$;

create trigger trg_pcs_validate_size_matrix
  before insert or update of per_pet_size_matrix_default on public.payroll_cycle_settings
  for each row execute function app.tg_validate_payroll_size_matrix();
create trigger trg_sps_validate_size_matrix
  before insert or update of per_pet_size_matrix on public.staff_payroll_settings
  for each row execute function app.tg_validate_payroll_size_matrix();

comment on column public.payroll_cycle_settings.per_pet_size_matrix_default is
  'Basic Grooming rate per dog size band: {band_key: rate}. Keys are the organization''s dog size-band keys (organization_size_bands.band_key); validated by trg_pcs_validate_size_matrix.';
comment on column public.staff_payroll_settings.per_pet_size_matrix is
  'Per-staff replacement of the organization size matrix (NULL = inherit). Keys are the organization''s dog size-band keys; validated by trg_sps_validate_size_matrix.';

-- ---------------------------------------------------------------------------
-- compute_payroll_item: identical to 20261010110000 except the per-dog matrix
-- loop, which groups by the resolved band key (not the raw pets.size column) and
-- records perDogDetail, and an empty search_path (every reference is already
-- schema-qualified). Same signature and stability.
-- ---------------------------------------------------------------------------
create or replace function app.compute_payroll_item(p_org uuid, p_membership uuid, p_period_start date, p_period_end date)
returns jsonb
security definer set search_path = ''
language plpgsql stable as $$
declare
  v_org_settings public.payroll_cycle_settings%rowtype;
  v_settings public.staff_payroll_settings%rowtype;
  v_basic numeric(14,2) := 0;
  v_day_stats jsonb;
  v_weekly numeric(14,2) := 0;
  v_no_late numeric(14,2) := 0;
  v_no_sick numeric(14,2) := 0;
  v_late_count int := 0;
  v_basic_count int := 0; v_botak_count int := 0; v_styling_count int := 0;
  v_styling_revenue numeric(14,2) := 0;
  v_botak_rate numeric(14,2); v_botak_amount numeric(14,2) := 0;
  v_tiers jsonb; v_styling_pct numeric := 0; v_styling_amount numeric(14,2) := 0;
  v_transport numeric(14,2) := 0;
  v_daily numeric(14,2) := 0;
  v_matrix jsonb; v_per_pet_rate numeric(14,2); v_basic_amount numeric(14,2) := 0;
  v_rate numeric; v_detail jsonb := '[]'::jsonb;
  r record;
begin
  select * into v_org_settings from public.payroll_cycle_settings where organization_id = p_org;
  if not found then
    raise exception 'payroll_cycle_settings_missing:%', p_org using errcode = 'no_data_found';
  end if;
  select * into v_settings from public.staff_payroll_settings where organization_id = p_org and membership_id = p_membership;

  select coalesce(sc.base_amount, 0) into v_basic
  from public.staff_compensation sc
  where sc.organization_id = p_org and sc.membership_id = p_membership and sc.is_active and sc.deleted_at is null
    and sc.effective_from <= (p_period_end - 1)
  order by sc.effective_from desc limit 1;
  v_basic := coalesce(v_basic, 0);

  v_day_stats := app.payroll_working_day_stats(p_org, p_membership, p_period_start, p_period_end);

  if coalesce(v_settings.weekly_salary_enabled, false) then
    v_weekly := round(coalesce(v_settings.weekly_salary_amount, v_org_settings.weekly_salary_amount_default) / 6.0
                * (v_day_stats ->> 'weekly_paid_days')::int, 2);
  end if;

  if coalesce(v_settings.no_late_enabled, false) then
    select count(*) into v_late_count
    from public.attendance_records ar
    join public.bookings b on b.organization_id = ar.organization_id and b.id = ar.booking_id
    where ar.organization_id = p_org and ar.membership_id = p_membership and ar.deleted_at is null
      and ar.classification = 'late' and ar.waived_at is null
      and (b.starts_at at time zone app.org_timezone(p_org))::date >= p_period_start
      and (b.starts_at at time zone app.org_timezone(p_org))::date < p_period_end;
    v_no_late := case when v_late_count = 0 then coalesce(v_settings.no_late_amount, v_org_settings.no_late_amount_default) else 0 end;
  end if;

  if coalesce(v_settings.no_sick_enabled, false) then
    v_no_sick := case when (v_day_stats ->> 'sick_days')::int = 0
      then coalesce(v_settings.no_sick_amount, v_org_settings.no_sick_amount_default) else 0 end;
  end if;

  select count(*) filter (where has_basic), count(*) filter (where has_botak), count(*) filter (where has_styling),
         coalesce(sum(styling_revenue) filter (where has_styling), 0)
    into v_basic_count, v_botak_count, v_styling_count, v_styling_revenue
  from app.payroll_eligible_pets(p_org, p_period_start, p_period_end) ep
  where ep.membership_id = p_membership;

  v_matrix := coalesce(v_settings.per_pet_size_matrix, v_org_settings.per_pet_size_matrix_default, '{}'::jsonb);
  v_per_pet_rate := coalesce(v_settings.per_pet_amount, v_org_settings.per_pet_amount_default);
  if coalesce(v_settings.per_pet_enabled, true) and v_basic_count > 0 then
    for r in
      select k.size_key, b.label as size_label, count(*) as n
      from app.payroll_eligible_pets(p_org, p_period_start, p_period_end) ep
      join public.pets pt on pt.organization_id = p_org and pt.id = ep.pet_id
      cross join lateral (select app.payroll_pet_size_key(p_org, pt.species, pt.weight_kg, pt.size) as size_key) k
      left join public.organization_size_bands b
        on b.organization_id = p_org and b.band_key = k.size_key and b.band_kind = 'dog_weight'
      where ep.membership_id = p_membership and ep.has_basic
      group by k.size_key, b.label, b.sort_order
      order by b.sort_order nulls last, k.size_key nulls last
    loop
      if r.size_key is not null and (v_matrix ? r.size_key) then
        -- coalesce guards a malformed/null matrix entry (e.g. {"small": null})
        -- from NULL-poisoning v_basic_amount for every subsequent size group
        -- in this loop -- falls back to the flat rate for that group only.
        v_rate := coalesce((v_matrix ->> r.size_key)::numeric, v_per_pet_rate);
      else
        v_rate := v_per_pet_rate;
      end if;
      v_basic_amount := v_basic_amount + v_rate * r.n;
      v_detail := v_detail || jsonb_build_object('key', r.size_key, 'label', r.size_label,
        'count', r.n, 'rate', v_rate, 'amount', v_rate * r.n);
    end loop;
  end if;

  v_botak_rate := coalesce(v_settings.botak_amount, v_org_settings.botak_amount_default);
  v_botak_amount := case when coalesce(v_settings.botak_enabled, true) and v_botak_count > 0
    then v_botak_rate * v_botak_count else 0 end;

  v_tiers := coalesce(nullif(v_settings.styling_tiers, '[]'::jsonb), v_org_settings.styling_tiers_default);
  if coalesce(v_settings.styling_enabled, false) then
    select coalesce(max((t ->> 'pct')::numeric), 0) into v_styling_pct
    from jsonb_array_elements(v_tiers) t
    where (t ->> 'min_jobs')::int <= v_styling_count;
  end if;
  v_styling_amount := round(v_styling_revenue * v_styling_pct / 100.0, 2);

  select coalesce(ts.transport_total, 0) into v_transport
  from app.payroll_transport_shares(p_org, p_period_start, p_period_end) ts
  where ts.membership_id = p_membership;
  v_transport := coalesce(v_transport, 0);

  if coalesce(v_settings.daily_enabled, false) then
    v_daily := coalesce(v_settings.daily_amount, v_org_settings.daily_amount_default) * (v_day_stats ->> 'worked')::int;
  end if;

  return jsonb_build_object(
    'basic', v_basic, 'weekly', v_weekly, 'noLate', v_no_late, 'noSick', v_no_sick,
    'styling', v_styling_amount, 'botak', v_botak_amount, 'transport', v_transport,
    'perDog', v_basic_amount, 'perDogDetail', v_detail, 'daily', v_daily,
    'meta', jsonb_build_object(
      'stylingCount', v_styling_count, 'stylingRevenue', v_styling_revenue, 'stylingAppliedPct', v_styling_pct,
      'botakCount', v_botak_count, 'basicCount', v_basic_count, 'lateCount', v_late_count,
      'sickDays', (v_day_stats ->> 'sick_days')::int, 'scheduledDays', (v_day_stats ->> 'scheduled')::int,
      'workedDays', (v_day_stats ->> 'worked')::int, 'weeklyPaidDays', (v_day_stats ->> 'weekly_paid_days')::int,
      'calculationVersion', 1
    )
  );
end; $$;

-- ---------------------------------------------------------------------------
-- Export detail rows: the size the payroll calculation uses (live key + current
-- label) plus the size recorded on the booking line when the service was priced
-- (immutable snapshot; a line priced before label snapshots existed shows its
-- key's band label, and a line with no size shows NULL). Adds an
-- explicit tenant/permission check: the previous definition trusted any
-- caller-supplied organization id. Return type changes, so drop and recreate.
-- ---------------------------------------------------------------------------
drop function app.payroll_export_detail_rows(uuid, date, date);
create function app.payroll_export_detail_rows(p_org uuid, p_period_start date, p_period_end date)
returns table(
  booking_id uuid, membership_id uuid, starts_at timestamptz,
  customer_name text, pet_name text, pet_size text, services text,
  service_revenue numeric, invoice_number text, invoice_id uuid, invoice_status text,
  pet_size_label text, service_size_key text, service_size_label text
)
security definer set search_path = ''
language plpgsql stable as $$
#variable_conflict use_column
begin
  if p_org is null or p_org is distinct from app.fn_active_organization()
     or not (app.has_membership() and app.has_module('payroll') and app.has_permission('payroll.read')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return query
  select
    b.id, ep.membership_id, b.starts_at,
    coalesce(c.display_name, 'Pelanggan')::text, coalesce(pt.name, 'Hewan')::text, k.size_key,
    string_agg(distinct sc.name, ', ' order by sc.name)::text,
    sum(gjps.unit_price_snapshot * gjps.quantity)::numeric,
    inv.invoice_number::text, inv.id, inv.status::text,
    sb.label::text,
    min(gjps.pet_size_snapshot) filter (where sc.payroll_role = 'basic_grooming')::text,
    min(coalesce(gjps.pet_size_label_snapshot, ls.label)) filter (where sc.payroll_role = 'basic_grooming')::text
  from app.payroll_eligible_pets(p_org, p_period_start, p_period_end) ep
  join public.bookings b on b.organization_id = p_org and b.id = ep.booking_id
  join public.pets pt on pt.organization_id = p_org and pt.id = ep.pet_id
  cross join lateral (select app.payroll_pet_size_key(p_org, pt.species, pt.weight_kg, pt.size) as size_key) k
  left join public.organization_size_bands sb
    on sb.organization_id = p_org and sb.band_key = k.size_key and sb.band_kind = 'dog_weight'
  left join public.customers c on c.organization_id = p_org and c.id = b.customer_id
  join public.grooming_job_pet_services gjps on gjps.organization_id = p_org
    and gjps.grooming_job_pet_id = ep.grooming_job_pet_id and gjps.deleted_at is null
  join public.service_catalog sc on sc.organization_id = p_org and sc.id = gjps.service_id
  -- lines priced before label snapshots existed carry only the (immutable) key: show that band's label
  left join public.organization_size_bands ls on ls.organization_id = p_org and ls.band_key = gjps.pet_size_snapshot
  left join public.orders ord on ord.organization_id = p_org and ord.booking_id = b.id and ord.deleted_at is null
  left join public.invoices inv on inv.organization_id = p_org and inv.order_id = ord.id and inv.status <> 'void'
  group by b.id, ep.membership_id, b.starts_at, c.display_name, pt.name, k.size_key, sb.label,
           inv.invoice_number, inv.id, inv.status;
end; $$;

-- ---------------------------------------------------------------------------
-- Grants. The calculation helpers are internal (reached only through the
-- definer recompute_payroll_run) and took a caller-supplied organization id with
-- no check, so client roles lose direct EXECUTE. The export RPC is the only new
-- or changed client entry point: authenticated only, never anon/public.
-- ---------------------------------------------------------------------------
revoke all on function app.payroll_pet_size_key(uuid, text, numeric, text),
  app.tg_validate_payroll_size_matrix() from public, anon, authenticated;
revoke all on function app.compute_payroll_item(uuid, uuid, date, date),
  app.payroll_eligible_pets(uuid, date, date),
  app.payroll_transport_shares(uuid, date, date) from public, anon, authenticated;
revoke all on function app.payroll_export_detail_rows(uuid, date, date) from public, anon;
grant execute on function app.payroll_export_detail_rows(uuid, date, date) to authenticated;

notify pgrst, 'reload schema';
commit;
