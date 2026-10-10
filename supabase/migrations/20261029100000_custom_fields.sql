-- E1.2 Customer 360 / pet custom fields (parity #3, #40).
--
-- Smallest tenant-scoped, owner-configurable field system: five scalar types
-- (text, number, date, boolean, single select), stable definition ids, entity
-- scope (customer | pet), ordering, active/archived state, server-validated
-- select options and typed value columns. There is deliberately no JSON value
-- column, formula support, public onboarding, search or export.
--
-- Authority: definitions are written with settings.manage, values with
-- customer.manage; the organization is always app.fn_active_organization().
-- Clients get SELECT only (RLS); every write goes through the RPCs below.
-- Archiving hides a definition from forms and refuses new writes but keeps the
-- stored values, so un-archiving restores them.
begin;

create table public.custom_field_definitions (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null check (entity_type in ('customer','pet')),
  label text not null check (length(btrim(label)) between 1 and 60),
  field_type text not null check (field_type in ('text','number','date','boolean','select')),
  -- [{"key":"o1","label":"..."}]; keys are server-assigned and never reused.
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  next_option_seq integer not null default 1 check (next_option_seq >= 1),
  sort_order integer not null default 0 check (sort_order between 0 and 9999),
  status text not null default 'active' check (status in ('active','archived')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint uq_custom_field_definitions_org_id unique (organization_id, id),
  constraint chk_custom_field_archive_stamp check ((status = 'archived') = (archived_at is not null)),
  constraint chk_custom_field_options_only_select check (field_type = 'select' or options = '[]'::jsonb)
);
create unique index uq_custom_field_definitions_label
  on public.custom_field_definitions (organization_id, entity_type, lower(btrim(label)));
create index idx_custom_field_definitions_scope
  on public.custom_field_definitions (organization_id, entity_type, status, sort_order);

create table public.custom_field_values (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  definition_id uuid not null,
  entity_type text not null check (entity_type in ('customer','pet')),
  customer_id uuid,
  pet_id uuid,
  value_text text check (value_text is null or length(value_text) between 1 and 200),
  value_number numeric(16,4),
  value_date date,
  value_boolean boolean,
  value_option text check (value_option is null or value_option ~ '^o[0-9]{1,6}$'),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint fk_custom_field_values_definition foreign key (organization_id, definition_id)
    references public.custom_field_definitions (organization_id, id),
  constraint fk_custom_field_values_customer foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade,
  constraint fk_custom_field_values_pet foreign key (organization_id, pet_id)
    references public.pets (organization_id, id) on delete cascade,
  constraint chk_custom_field_values_one_entity check (
    (entity_type = 'customer' and customer_id is not null and pet_id is null)
    or (entity_type = 'pet' and pet_id is not null and customer_id is null)),
  constraint chk_custom_field_values_one_value check (
    num_nonnulls(value_text, value_number, value_date, value_boolean, value_option) = 1)
);
create unique index uq_custom_field_values_entity on public.custom_field_values (definition_id, coalesce(customer_id, pet_id));
create index idx_custom_field_values_customer on public.custom_field_values (organization_id, customer_id) where customer_id is not null;
create index idx_custom_field_values_pet on public.custom_field_values (organization_id, pet_id) where pet_id is not null;

create trigger trg_custom_field_definitions_updated_at before update on public.custom_field_definitions
  for each row execute function app.tg_set_updated_at();
create trigger trg_custom_field_values_updated_at before update on public.custom_field_values
  for each row execute function app.tg_set_updated_at();
create trigger trg_custom_field_definitions_audit after insert or update or delete on public.custom_field_definitions
  for each row execute function app.tg_write_audit();
create trigger trg_custom_field_values_audit after insert or update or delete on public.custom_field_values
  for each row execute function app.tg_write_audit();

alter table public.custom_field_definitions enable row level security;
alter table public.custom_field_values enable row level security;
revoke all on public.custom_field_definitions, public.custom_field_values from public, anon, authenticated;
grant select on public.custom_field_definitions, public.custom_field_values to authenticated;
create policy custom_field_definitions_read on public.custom_field_definitions for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()
    and app.has_module('crm') and app.has_permission('customer.read')));
create policy custom_field_values_read on public.custom_field_values for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()
    and app.has_module('crm') and app.has_permission('customer.read')));

-- ---------------------------------------------------------------------------
-- Definition writes (settings.manage). Type and entity are immutable after
-- creation: changing them would silently reinterpret stored values.
-- ---------------------------------------------------------------------------
create function app.save_custom_field_definition(
  p_id uuid,
  p_entity_type text,
  p_label text,
  p_field_type text,
  p_option_labels text[],
  p_sort_order integer,
  p_expected_updated_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_label text := btrim(coalesce(p_label, ''));
  v_def public.custom_field_definitions;
  v_labels text[] := '{}';
  v_item text;
  v_options jsonb := '[]'::jsonb;
  v_seq integer;
  v_key text;
  v_existing text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm')
     or not app.has_permission('settings.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('custom_fields:' || v_org::text, 0));

  if length(v_label) not between 1 and 60 or v_label ~ '[[:cntrl:]]'
     or p_sort_order is null or p_sort_order not between 0 and 9999 then
    raise exception 'invalid_custom_field' using errcode = '22023';
  end if;

  if p_id is not null then
    select d.* into v_def from public.custom_field_definitions d
     where d.organization_id = v_org and d.id = p_id for update;
    if not found then raise exception 'definition_not_found' using errcode = 'P0002'; end if;
    if v_def.updated_at is distinct from p_expected_updated_at then
      raise exception 'stale_definition' using errcode = '40001'; end if;
    if v_def.status <> 'active' then raise exception 'definition_archived' using errcode = '22023'; end if;
    if (p_entity_type is not null and p_entity_type <> v_def.entity_type)
       or (p_field_type is not null and p_field_type <> v_def.field_type) then
      raise exception 'definition_type_immutable' using errcode = '22023';
    end if;
  else
    if p_entity_type not in ('customer','pet') or p_field_type not in ('text','number','date','boolean','select') then
      raise exception 'invalid_custom_field' using errcode = '22023'; end if;
    if (select count(*) from public.custom_field_definitions d
         where d.organization_id = v_org and d.entity_type = p_entity_type and d.status = 'active') >= 20 then
      raise exception 'too_many_custom_fields' using errcode = '22023'; end if;
  end if;

  if coalesce(v_def.field_type, p_field_type) = 'select' then
    foreach v_item in array coalesce(p_option_labels, '{}') loop
      v_item := btrim(coalesce(v_item, ''));
      if length(v_item) not between 1 and 40 or v_item ~ '[[:cntrl:]]' or lower(v_item) = any (v_labels) then
        raise exception 'invalid_custom_field_options' using errcode = '22023'; end if;
      v_labels := v_labels || lower(v_item);
    end loop;
    if coalesce(array_length(v_labels, 1), 0) not between 1 and 12 then
      raise exception 'invalid_custom_field_options' using errcode = '22023'; end if;
    v_seq := coalesce(v_def.next_option_seq, 1);
    foreach v_item in array p_option_labels loop
      v_item := btrim(v_item);
      -- A label that already exists keeps its key; anything else is a new option.
      v_key := null;
      if p_id is not null then
        select o ->> 'key' into v_key from jsonb_array_elements(v_def.options) o
         where lower(o ->> 'label') = lower(v_item) limit 1;
      end if;
      if v_key is null then v_key := 'o' || v_seq::text; v_seq := v_seq + 1; end if;
      v_options := v_options || jsonb_build_array(jsonb_build_object('key', v_key, 'label', v_item));
    end loop;
  elsif coalesce(array_length(p_option_labels, 1), 0) > 0 then
    raise exception 'invalid_custom_field_options' using errcode = '22023';
  end if;

  if p_id is null then
    begin
      insert into public.custom_field_definitions(organization_id, entity_type, label, field_type, options, next_option_seq, sort_order, created_by, updated_by)
      values (v_org, p_entity_type, v_label, p_field_type, v_options, coalesce(v_seq, 1), p_sort_order, app.fn_current_user_id(), app.fn_current_user_id())
      returning id into p_id;
    exception when unique_violation then
      raise exception 'duplicate_custom_field_label' using errcode = '22023';
    end;
  else
    begin
      update public.custom_field_definitions
         set label = v_label, options = v_options, next_option_seq = coalesce(v_seq, v_def.next_option_seq),
             sort_order = p_sort_order, updated_by = app.fn_current_user_id()
       where organization_id = v_org and id = p_id;
    exception when unique_violation then
      raise exception 'duplicate_custom_field_label' using errcode = '22023';
    end;
  end if;
  return p_id;
end $$;

create function app.set_custom_field_archived(p_id uuid, p_archived boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_def public.custom_field_definitions;
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm')
     or not app.has_permission('settings.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_id is null or p_archived is null then raise exception 'invalid_custom_field' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('custom_fields:' || v_org::text, 0));
  select d.* into v_def from public.custom_field_definitions d where d.organization_id = v_org and d.id = p_id for update;
  if not found then raise exception 'definition_not_found' using errcode = 'P0002'; end if;
  if p_archived then
    update public.custom_field_definitions set status = 'archived', archived_at = coalesce(archived_at, now()),
           updated_by = app.fn_current_user_id() where id = v_def.id and status = 'active';
  else
    if (select count(*) from public.custom_field_definitions d
         where d.organization_id = v_org and d.entity_type = v_def.entity_type and d.status = 'active') >= 20 then
      raise exception 'too_many_custom_fields' using errcode = '22023'; end if;
    update public.custom_field_definitions set status = 'active', archived_at = null,
           updated_by = app.fn_current_user_id() where id = v_def.id and status = 'archived';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Value writes (customer.manage). p_values: {"<definition uuid>": "<text>" | null}.
-- An empty string or null clears the stored value. Archived definitions and
-- definitions of another entity type or tenant are refused.
-- ---------------------------------------------------------------------------
create function app.set_custom_field_values(p_entity_type text, p_entity_id uuid, p_values jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_key text;
  v_raw jsonb;
  v_text text;
  v_def public.custom_field_definitions;
  v_changed integer := 0;
  v_rows integer;
  v_customer uuid;
  v_pet uuid;
  v_vt text; v_vn numeric; v_vd date; v_vb boolean; v_vo text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm')
     or not app.has_permission('customer.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_entity_type not in ('customer','pet') or p_entity_id is null
     or p_values is null or jsonb_typeof(p_values) <> 'object'
     or (select count(*) from jsonb_object_keys(p_values)) > 40 then
    raise exception 'invalid_custom_value' using errcode = '22023';
  end if;

  if p_entity_type = 'customer' then
    select c.id into v_customer from public.customers c
     where c.organization_id = v_org and c.id = p_entity_id and c.deleted_at is null for share of c;
    if not found then raise exception 'entity_not_found' using errcode = 'P0002'; end if;
  else
    select p.id into v_pet from public.pets p
      join public.customers c on c.organization_id = p.organization_id and c.id = p.customer_id
     where p.organization_id = v_org and p.id = p_entity_id and p.deleted_at is null and c.deleted_at is null
       for share of p;
    if not found then raise exception 'entity_not_found' using errcode = 'P0002'; end if;
  end if;

  for v_key, v_raw in select * from jsonb_each(p_values) loop
    if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_raw) not in ('string','null') then
      raise exception 'invalid_custom_value' using errcode = '22023'; end if;
    select d.* into v_def from public.custom_field_definitions d
     where d.organization_id = v_org and d.id = v_key::uuid
       and d.entity_type = p_entity_type and d.status = 'active';
    if not found then raise exception 'invalid_custom_field' using errcode = '22023'; end if;

    v_text := case when jsonb_typeof(v_raw) = 'string' then btrim(v_raw #>> '{}') else null end;
    if v_text is null or v_text = '' then
      delete from public.custom_field_values
       where organization_id = v_org and definition_id = v_def.id
         and customer_id is not distinct from v_customer and pet_id is not distinct from v_pet;
      get diagnostics v_rows = row_count;
      v_changed := v_changed + v_rows;
      continue;
    end if;

    v_vt := null; v_vn := null; v_vd := null; v_vb := null; v_vo := null;
    if v_def.field_type = 'text' then
      -- Leading = + - @ (spreadsheet formula triggers) and control characters are refused outright.
      if length(v_text) > 200 or v_text ~ '[[:cntrl:]]' or v_text ~ '^[=+@-]' then
        raise exception 'invalid_custom_value' using errcode = '22023'; end if;
      v_vt := v_text;
    elsif v_def.field_type = 'number' then
      if v_text !~ '^-?[0-9]{1,12}(\.[0-9]{1,4})?$' then
        raise exception 'invalid_custom_value' using errcode = '22023'; end if;
      v_vn := v_text::numeric;
    elsif v_def.field_type = 'date' then
      if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'invalid_custom_value' using errcode = '22023'; end if;
      begin
        v_vd := v_text::date;
      exception when others then
        raise exception 'invalid_custom_value' using errcode = '22023';
      end;
      if v_vd::text <> v_text or v_vd < date '1900-01-01' or v_vd > date '2100-12-31' then
        raise exception 'invalid_custom_value' using errcode = '22023'; end if;
    elsif v_def.field_type = 'boolean' then
      if v_text not in ('true','false') then
        raise exception 'invalid_custom_value' using errcode = '22023'; end if;
      v_vb := v_text = 'true';
    else
      if not exists (select 1 from jsonb_array_elements(v_def.options) o where o ->> 'key' = v_text) then
        raise exception 'invalid_custom_value' using errcode = '22023'; end if;
      v_vo := v_text;
    end if;

    insert into public.custom_field_values(organization_id, definition_id, entity_type, customer_id, pet_id,
        value_text, value_number, value_date, value_boolean, value_option, created_by, updated_by)
    values (v_org, v_def.id, p_entity_type, v_customer, v_pet, v_vt, v_vn, v_vd, v_vb, v_vo,
        app.fn_current_user_id(), app.fn_current_user_id())
    on conflict (definition_id, coalesce(customer_id, pet_id)) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      update public.custom_field_values v
         set value_text = v_vt, value_number = v_vn, value_date = v_vd, value_boolean = v_vb,
             value_option = v_vo, updated_by = app.fn_current_user_id()
       where v.organization_id = v_org and v.definition_id = v_def.id
         and v.customer_id is not distinct from v_customer and v.pet_id is not distinct from v_pet
         and (v.value_text, v.value_number, v.value_date, v.value_boolean, v.value_option)
             is distinct from (v_vt, v_vn, v_vd, v_vb, v_vo);
      get diagnostics v_rows = row_count;
    end if;
    v_changed := v_changed + v_rows;
  end loop;
  return v_changed;
end $$;

revoke all on function app.save_custom_field_definition(uuid, text, text, text, text[], integer, timestamptz),
  app.set_custom_field_archived(uuid, boolean), app.set_custom_field_values(text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function app.save_custom_field_definition(uuid, text, text, text, text[], integer, timestamptz),
  app.set_custom_field_archived(uuid, boolean), app.set_custom_field_values(text, uuid, jsonb)
  to authenticated;

-- Make the new RPCs visible to PostgREST without waiting for its schema-cache refresh.
notify pgrst, 'reload schema';
commit;
