-- =====================================================================
-- Structured Indonesian customer addresses (multi-address, tenant-safe).
--
-- customers.address/latitude/longitude (single, generic) stay in place for
-- backward compatibility — nothing reads them exclusively today, and
-- Customer 360 already falls back to them when no saved address exists.
-- This table is the new, first-class source for home-service addressing:
-- multiple addresses per customer, one marked default, full Indonesian
-- address components, and access/landmark notes a groomer needs on-site.
-- =====================================================================

create table public.customer_addresses (
  id                uuid        not null default app.fn_uuid_v7(),
  organization_id   uuid        not null,
  customer_id       uuid        not null,
  label             text        not null default 'Rumah',       -- Rumah, Kantor, etc — free text, not an enum
  recipient_name    text,
  recipient_phone   text,
  line1             text        not null,
  line2             text,
  rt                text,
  rw                text,
  kelurahan         text,                                       -- kelurahan/desa
  kecamatan         text,
  kabupaten_kota    text,
  province          text,
  postal_code       text,
  landmark          text,
  access_notes      text,                                       -- gate/parking/building/security instructions
  latitude          numeric(9,6),
  longitude         numeric(9,6),
  is_default        boolean     not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid,
  updated_by        uuid,
  deleted_at        timestamptz,
  constraint pk_customer_addresses primary key (id),
  constraint fk_customer_addresses_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  -- composite FK: an address MUST belong to a customer in the same organization (tenant integrity)
  constraint fk_customer_addresses_customers foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade,
  constraint uq_customer_addresses_org_id unique (organization_id, id),   -- composite-FK target (booking snapshot)
  constraint chk_customer_addresses_phone
    check (recipient_phone is null or recipient_phone ~ '^\+?[0-9][0-9 .\-()]{6,19}$'),
  constraint chk_customer_addresses_postal
    check (postal_code is null or postal_code ~ '^[0-9]{4,10}$')
);
create index idx_customer_addresses_org_customer on public.customer_addresses (organization_id, customer_id) where deleted_at is null;
-- exactly one non-deleted default address per customer
create unique index uq_customer_addresses_one_default on public.customer_addresses (organization_id, customer_id)
  where is_default and deleted_at is null;

create trigger trg_customer_addresses_updated_at before update on public.customer_addresses
  for each row execute function app.tg_set_updated_at();
create trigger trg_customer_addresses_audit_cols before insert or update on public.customer_addresses
  for each row execute function app.tg_set_audit_columns();

alter table public.customer_addresses enable row level security;

grant select, insert, update, delete on public.customer_addresses to authenticated;

-- permissive: tenant isolation (same shape as customers/pets)
create policy customer_addresses_org_isolation on public.customer_addresses for all
  using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()))
  with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()));

-- restrictive: same module/permission gate as customers/pets ('crm' module, 'customer.manage' to write)
create policy customer_addresses_module_gate on public.customer_addresses as restrictive for all
  using (app.is_platform_admin() or app.has_module('crm'))
  with check (app.is_platform_admin() or app.has_module('crm'));
create policy customer_addresses_write_ins on public.customer_addresses as restrictive for insert
  with check (app.is_platform_admin() or app.has_permission('customer.manage'));
create policy customer_addresses_write_upd on public.customer_addresses as restrictive for update
  using (app.is_platform_admin() or app.has_permission('customer.manage'))
  with check (app.is_platform_admin() or app.has_permission('customer.manage'));
create policy customer_addresses_write_del on public.customer_addresses as restrictive for delete
  using (app.is_platform_admin() or app.has_permission('customer.manage'));

-- One default address per customer, enforced at the app layer on write, but also
-- exposed here as a helper so RPCs/triggers can promote a new default atomically.
create or replace function app.fn_set_default_customer_address(p_address_id uuid)
returns void
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_org uuid := app.fn_active_organization();
  v_customer uuid;
begin
  if not app.has_permission('customer.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select customer_id into v_customer
  from public.customer_addresses
  where id = p_address_id and organization_id = v_org and deleted_at is null;
  if v_customer is null then
    raise exception 'address_not_found' using errcode = 'P0002';
  end if;
  update public.customer_addresses
    set is_default = false
    where organization_id = v_org and customer_id = v_customer and id <> p_address_id and is_default;
  update public.customer_addresses
    set is_default = true
    where organization_id = v_org and id = p_address_id;
end;
$$;
revoke all on function app.fn_set_default_customer_address(uuid) from public;
grant execute on function app.fn_set_default_customer_address(uuid) to authenticated;

-- Backfill: customers with existing address/lat/lng become one default row.
-- The old columns' shape was a flatter jsonb blob (line1/line2/district/city/
-- province/postal_code) built ad hoc in app code — mapped best-effort below.
-- customers.address/latitude/longitude are left untouched for compatibility.
insert into public.customer_addresses (
  organization_id, customer_id, label, line1, line2, kecamatan, kabupaten_kota,
  province, postal_code, latitude, longitude, is_default
)
select
  c.organization_id,
  c.id,
  'Rumah',
  coalesce(nullif(c.address->>'line1', ''), 'Alamat belum lengkap'),
  nullif(c.address->>'line2', ''),
  nullif(c.address->>'district', ''),
  nullif(c.address->>'city', ''),
  nullif(c.address->>'province', ''),
  nullif(c.address->>'postal_code', ''),
  c.latitude,
  c.longitude,
  true
from public.customers c
where c.deleted_at is null
  and (
    coalesce(nullif(c.address->>'line1', ''), '') <> ''
    or c.latitude is not null
    or c.longitude is not null
  );
