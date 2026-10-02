-- Persist stable, tenant-scoped customer display codes.
begin;

alter table public.customers
  add column customer_code text;

with numbered as (
  select id,
         row_number() over (
           partition by organization_id
           order by created_at asc, id asc
         ) as sequence_number
    from public.customers
)
update public.customers c
   set customer_code = 'CUST-' || lpad(
     numbered.sequence_number::text,
     greatest(3, length(numbered.sequence_number::text)),
     '0'
   )
  from numbered
 where c.id = numbered.id;

alter table public.customers
  alter column customer_code set not null,
  add constraint chk_customers_customer_code_format
    check (customer_code ~ '^CUST-[0-9]+$');

create unique index uq_customers_org_customer_code
  on public.customers (organization_id, customer_code);

comment on column public.customers.customer_code is
  'Immutable tenant-scoped display code (CUST-NNN minimum width), assigned on insert.';

create or replace function app.tg_assign_customer_code()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_next bigint;
begin
  if new.customer_code is not null and btrim(new.customer_code) <> '' then
    raise exception 'customer_code_is_assigned_by_database'
      using errcode = '42501';
  end if;

  if new.organization_id is null then
    raise exception 'customer_code_requires_organization'
      using errcode = '23502';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('customer_code:' || new.organization_id::text, 0)
  );

  select coalesce(max(substring(customer_code from 6)::bigint), 0) + 1
    into v_next
    from public.customers
   where organization_id = new.organization_id;

  new.customer_code := 'CUST-' || lpad(
    v_next::text,
    greatest(3, length(v_next::text)),
    '0'
  );
  return new;
end;
$$;

revoke execute on function app.tg_assign_customer_code()
  from public, anon, authenticated;

create trigger trg_customers_assign_code
  before insert on public.customers
  for each row execute function app.tg_assign_customer_code();

create or replace function app.tg_customer_code_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.customer_code is distinct from new.customer_code then
    raise exception 'customer_code_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function app.tg_customer_code_immutable()
  from public, anon, authenticated;

create trigger trg_customers_code_immutable
  before update of customer_code on public.customers
  for each row execute function app.tg_customer_code_immutable();

notify pgrst, 'reload schema';
commit;
