-- Platform-created organizations are ready for normal operation immediately.
-- Their human-readable name remains the only required input; the web action
-- derives a collision-safe internal slug before calling this RPC.
begin;

create or replace function app.prepare_operro_organization(p_name text, p_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_owner uuid; v_admin uuid; v_helper uuid; v_groomer uuid;
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode = '42501'; end if;
  p_name := btrim(p_name); p_slug := lower(btrim(p_slug));
  if length(p_name) not between 2 and 100 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) > 60 then
    raise exception 'invalid_organization' using errcode = '22023';
  end if;

  insert into public.organizations(name,slug,status,vertical,settings)
  values(p_name,p_slug,'active','grooming',jsonb_build_object('currency','IDR','timezone','Asia/Jakarta','provisioned_by','Operro'))
  returning id into v_org;
  insert into public.branches(organization_id,name,status,timezone,is_default)
  values(v_org,'Cabang utama','active','Asia/Jakarta',true);
  insert into public.roles(organization_id,name,description,is_system) values
    (v_org,'Pemilik','Pemilik bisnis; mengelola akses dan payroll',true),
    (v_org,'Admin','Izin operasional dipilih pemilik bisnis',true),
    (v_org,'Bantuan Operro','Bantuan lintas-organisasi tanpa akses payroll',true),
    (v_org,'Groomer','Jadwal pribadi dan bukti grooming',true);
  select id into v_owner from public.roles where organization_id=v_org and name='Pemilik';
  select id into v_admin from public.roles where organization_id=v_org and name='Admin';
  select id into v_helper from public.roles where organization_id=v_org and name='Bantuan Operro';
  select id into v_groomer from public.roles where organization_id=v_org and name='Groomer';
  insert into public.role_permissions(organization_id,role_id,permission_id)
  select v_org,v_owner,p.id from public.permissions p where p.deleted_at is null;
  insert into public.role_permissions(organization_id,role_id,permission_id)
  select v_org,v_admin,p.id from public.permissions p
  where p.key in ('booking.read','booking.create','booking.update','booking.cancel','customer.read','customer.manage','resource.manage','service.manage','membership.read','membership.manage','invoice.issue','finance.read','payment.manage','task.manage','reports.view','branches.all','settings.manage')
    and p.deleted_at is null;
  insert into public.role_permissions(organization_id,role_id,permission_id)
  select v_org,v_helper,p.id from public.permissions p
  where p.deleted_at is null and p.key not like 'payroll.%'
    and p.key not in ('roles.manage','users.manage','finance.read','reports.view');
  insert into public.role_permissions(organization_id,role_id,permission_id)
  select v_org,v_groomer,p.id from public.permissions p
  where p.key in ('booking.read','booking.update') and p.deleted_at is null;
  insert into public.subscriptions(organization_id,status,current_period_start,current_period_end)
  values(v_org,'active',now(),now()+interval '30 days');
  insert into public.organization_modules(organization_id,module_id,enabled,source)
  select v_org,m.id,true,'override' from public.modules m where m.is_active;
  return v_org;
end;
$$;

revoke all on function app.prepare_operro_organization(text,text) from public;
grant execute on function app.prepare_operro_organization(text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
