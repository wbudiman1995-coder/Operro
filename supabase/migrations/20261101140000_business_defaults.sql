-- Stream 5: typed business defaults - suggested customer source labels and the default invoice due period (parity #39).
--
-- HomePaw keeps two more settings in its single configuration object that Operro had no home for:
--   sourceLabels  the list offered in the customer "source" dropdown
--   dueDayDefault the default due date of a new invoice
-- Both are adopted ONLY as behaviors that cannot change history or break existing data:
--   * source labels are SUGGESTIONS. Customer source stays free text (existing customers keep what they have, the dashboard still
--     normalizes case and spacing). The labels only populate suggestion lists in forms; nothing refuses another value.
--   * the due period pre-fills the due date of a NEW invoice (issue date + N days). It never rewrites an existing invoice, and the date
--     stays editable. NULL keeps the existing behavior (the day after the issue date).
--
-- One typed row per organization (public.organization_business_defaults) with validation in the database, optimistic concurrency on a
-- version number and the existing audit trigger. There is no generic settings editor. Reading is open to any member of the
-- organization (forms pre-fill from it); writing needs the business owner or settings.manage.
begin;

create function app.valid_source_labels(p_labels text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_labels is not null
     and cardinality(p_labels) <= 20
     and not exists (select 1 from unnest(p_labels) l where l is null or l <> btrim(l) or length(l) not between 1 and 40 or l ~ '[\x00-\x1f]' or l <> regexp_replace(l, '\s+', ' ', 'g'))
     and (select count(distinct app.normalize_source_key(l)) from unnest(p_labels) l) = cardinality(p_labels);
$$;
revoke all on function app.valid_source_labels(text[]) from public, anon, authenticated;

create table public.organization_business_defaults (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- a uuid id so the organization export (which pages by id) can archive this configuration like any other table
  id uuid not null unique default app.fn_uuid_v7(),
  source_labels text[] not null default '{}' check (app.valid_source_labels(source_labels)),
  invoice_due_days smallint check (invoice_due_days is null or invoice_due_days between 0 and 365),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create trigger trg_organization_business_defaults_updated_at before update on public.organization_business_defaults
  for each row execute function app.tg_set_updated_at();
create trigger trg_organization_business_defaults_audit after insert or update or delete on public.organization_business_defaults
  for each row execute function app.tg_write_audit();

alter table public.organization_business_defaults enable row level security;
revoke all on public.organization_business_defaults from public, anon, authenticated;
grant select on public.organization_business_defaults to authenticated;
create policy organization_business_defaults_read on public.organization_business_defaults for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()));

create function app.set_business_defaults(p_source_labels text[], p_invoice_due_days integer, p_expected_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_user uuid := app.fn_current_user_id();
  v_labels text[];
  v_row public.organization_business_defaults;
begin
  if v_org is null or not app.has_membership() or not (app.is_business_owner_member(v_org) or app.has_permission('settings.manage')) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_source_labels is null or p_expected_version is null or p_expected_version < 0
     or (p_invoice_due_days is not null and p_invoice_due_days not between 0 and 365) then
    raise exception 'invalid_business_defaults' using errcode = '22023'; end if;
  -- trim and collapse spaces per label; empty labels are dropped; the result must satisfy the same rule as the table
  select coalesce(array_agg(x.label order by x.ord), '{}') into v_labels
    from (select btrim(regexp_replace(l.value, '\s+', ' ', 'g')) as label, l.ord from unnest(p_source_labels) with ordinality l(value, ord)) x
   where x.label <> '';
  if not app.valid_source_labels(v_labels) then raise exception 'invalid_source_labels' using errcode = '22023'; end if;

  select d.* into v_row from public.organization_business_defaults d where d.organization_id = v_org for update;
  if not found then
    if p_expected_version <> 0 then raise exception 'stale_defaults' using errcode = '40001'; end if;
    insert into public.organization_business_defaults(organization_id, source_labels, invoice_due_days, created_by, updated_by)
    values (v_org, v_labels, p_invoice_due_days, v_user, v_user);
    return 1;
  end if;
  if v_row.version <> p_expected_version then raise exception 'stale_defaults' using errcode = '40001'; end if;
  update public.organization_business_defaults
     set source_labels = v_labels, invoice_due_days = p_invoice_due_days, version = version + 1, updated_by = v_user
   where organization_id = v_org
   returning version into v_row.version;
  return v_row.version;
end $$;

revoke all on function app.set_business_defaults(text[], integer, integer) from public, anon, authenticated;
grant execute on function app.set_business_defaults(text[], integer, integer) to authenticated;

-- The defaults are owner configuration worth keeping in the organization archive.
insert into app.organization_export_table_specs (table_name, sort_order, reason)
values ('organization_business_defaults', 288, 'business defaults: suggested source labels and default invoice due period')
on conflict (table_name) do nothing;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101140000'::text;
$$;

notify pgrst, 'reload schema';
commit;
