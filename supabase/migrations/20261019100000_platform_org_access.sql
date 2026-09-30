-- Operro-owned organization provisioning and one-time, email-bound invitations.
-- No service-role key is exposed to the web app. The invitee registers or signs in
-- with Supabase Auth, then claims the link as the same verified email address.
begin;

-- The existing Operro account predates this panel. Grant the platform flag only
-- to its already-created, active user row; all other accounts remain unchanged.
update public.users
set is_platform_admin = true
where lower(email) = 'wbudiman1995@gmail.com'
  and status = 'active'
  and deleted_at is null
  and not is_platform_admin;

create table public.platform_access_invitations (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id),
  email text not null,
  role_name text not null check (role_name in ('Pemilik','Admin','Bantuan Operro','Groomer')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id),
  constraint chk_platform_invite_email check (email = lower(btrim(email)) and email ~ '^[^@ ]+@[^@ ]+\.[^@ ]+$')
);
create index idx_platform_access_invites_org on public.platform_access_invitations(organization_id, created_at desc);
alter table public.platform_access_invitations enable row level security;
-- Invitations are accessed only through the narrowly scoped definer RPCs.
revoke all on public.platform_access_invitations from anon, authenticated;

create function app.is_operro_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and lower(u.email) = 'wbudiman1995@gmail.com'
      and u.is_platform_admin and u.status = 'active' and u.deleted_at is null
  );
$$;
revoke all on function app.is_operro_owner() from public;
grant execute on function app.is_operro_owner() to authenticated;

create function app.is_business_owner(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_operro_owner() or exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id and r.organization_id = m.organization_id
    join public.organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and m.organization_id = p_org
      and m.status = 'active' and m.deleted_at is null
      and r.name = 'Pemilik' and r.deleted_at is null
      and o.status in ('trial','active') and o.deleted_at is null
  );
$$;
revoke all on function app.is_business_owner(uuid) from public;
grant execute on function app.is_business_owner(uuid) to authenticated;

create function app.prepare_operro_organization(p_name text, p_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_owner uuid; v_admin uuid; v_helper uuid; v_groomer uuid;
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode = '42501'; end if;
  p_name := btrim(p_name); p_slug := lower(btrim(p_slug));
  if length(p_name) not between 2 and 100 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) > 60 then
    raise exception 'invalid_organization' using errcode = '22023';
  end if;
  insert into public.organizations(name,slug,status,vertical,settings)
  values(p_name,p_slug,'trial','grooming',jsonb_build_object('currency','IDR','timezone','Asia/Jakarta','provisioned_by','Operro'))
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
  values(v_org,'trialing',now(),now()+interval '30 days');
  insert into public.organization_modules(organization_id,module_id,enabled,source)
  select v_org,m.id,true,'override' from public.modules m where m.is_active;
  return v_org;
end;
$$;
revoke all on function app.prepare_operro_organization(text,text) from public;
grant execute on function app.prepare_operro_organization(text,text) to authenticated;

create function app.issue_access_invitation(p_org uuid,p_email text,p_role text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text; v_email text := lower(btrim(p_email));
begin
  if p_role not in ('Pemilik','Admin','Bantuan Operro','Groomer')
    or not exists(select 1 from public.roles where organization_id=p_org and name=p_role and deleted_at is null)
    or not exists(select 1 from public.organizations where id=p_org and status in ('trial','active') and deleted_at is null)
  then raise exception 'invalid_invitation' using errcode='22023'; end if;
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode='42501'; end if;
  if v_email !~ '^[^@ ]+@[^@ ]+\.[^@ ]+$' or length(v_email)>254 then
    raise exception 'invalid_email' using errcode='22023'; end if;
  update public.platform_access_invitations set status='revoked'
  where organization_id=p_org and email=v_email and status='pending';
  v_token := replace(pg_catalog.gen_random_uuid()::text,'-','') || replace(pg_catalog.gen_random_uuid()::text,'-','');
  insert into public.platform_access_invitations(organization_id,email,role_name,token_hash,expires_at,created_by)
  values(p_org,v_email,p_role,encode(extensions.digest(v_token,'sha256'),'hex'),now()+interval '7 days',auth.uid());
  return v_token;
end;
$$;
revoke all on function app.issue_access_invitation(uuid,text,text) from public;
grant execute on function app.issue_access_invitation(uuid,text,text) to authenticated;

create function app.claim_access_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_inv public.platform_access_invitations; v_user public.users; v_role uuid;
begin
  if auth.uid() is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_invitation' using errcode='22023'; end if;
  select * into v_inv from public.platform_access_invitations
  where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
  if not found or v_inv.status<>'pending' or v_inv.expires_at<=now() then
    raise exception 'invitation_unavailable' using errcode='22023'; end if;
  select * into v_user from public.users where id=auth.uid() and status='active' and deleted_at is null;
  if not found or lower(v_user.email)<>v_inv.email
    or not exists(select 1 from auth.users au where au.id=auth.uid() and au.email_confirmed_at is not null)
  then raise exception 'wrong_or_unverified_email' using errcode='42501'; end if;
  select id into v_role from public.roles where organization_id=v_inv.organization_id and name=v_inv.role_name and deleted_at is null;
  if v_role is null or not exists(select 1 from public.organizations where id=v_inv.organization_id and status in ('trial','active') and deleted_at is null)
  then raise exception 'organization_unavailable' using errcode='22023'; end if;
  -- An older link must never reactivate a suspended member or replace a role.
  if exists (select 1 from public.memberships where user_id=auth.uid() and organization_id=v_inv.organization_id) then
    raise exception 'membership_already_exists' using errcode='22023';
  end if;
  insert into public.memberships(user_id,organization_id,role_id,status)
  values(auth.uid(),v_inv.organization_id,v_role,'active');
  update public.platform_access_invitations set status='accepted',accepted_at=now(),accepted_by=auth.uid() where id=v_inv.id;
  update public.users set active_organization_id=v_inv.organization_id where id=auth.uid();
  return v_inv.organization_id;
end;
$$;
revoke all on function app.claim_access_invitation(text) from public;
grant execute on function app.claim_access_invitation(text) to authenticated;

-- A groomer's linked staff resource defines the branch in which they may see
-- assignments. Keep branch access in sync when a manager links or moves a
-- resource; an invitation alone does not expose every branch's bookings.
create function app.sync_staff_resource_branch_access() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='DELETE' then
    if old.membership_id is not null and old.branch_id is not null
      and not exists (select 1 from public.resources r where r.organization_id=old.organization_id
        and r.membership_id=old.membership_id and r.branch_id=old.branch_id
        and r.kind='staff' and r.status='active' and r.deleted_at is null)
    then delete from public.membership_branch_access
      where organization_id=old.organization_id and membership_id=old.membership_id and branch_id=old.branch_id;
    end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.membership_id is not null and old.branch_id is not null
    and (old.membership_id is distinct from new.membership_id
      or old.branch_id is distinct from new.branch_id or new.status<>'active' or new.deleted_at is not null)
    and not exists (select 1 from public.resources r where r.organization_id=old.organization_id
      and r.membership_id=old.membership_id and r.branch_id=old.branch_id
      and r.kind='staff' and r.status='active' and r.deleted_at is null)
  then
    delete from public.membership_branch_access
    where organization_id=old.organization_id and membership_id=old.membership_id and branch_id=old.branch_id;
  end if;
  if new.kind='staff' and new.status='active' and new.deleted_at is null and new.membership_id is not null and new.branch_id is not null then
    insert into public.membership_branch_access(organization_id,membership_id,branch_id)
    values(new.organization_id,new.membership_id,new.branch_id)
    on conflict (membership_id,branch_id) do nothing;
  end if;
  return new;
end $$;
create trigger trg_staff_resource_branch_access
after insert or update of membership_id,branch_id,status,deleted_at or delete on public.resources
for each row execute function app.sync_staff_resource_branch_access();
insert into public.membership_branch_access(organization_id,membership_id,branch_id)
select distinct r.organization_id,r.membership_id,r.branch_id from public.resources r
where r.kind='staff' and r.membership_id is not null and r.branch_id is not null and r.deleted_at is null
on conflict (membership_id,branch_id) do nothing;

-- The branch grant lets the existing schedule queries work, but a Groomer
-- must never use a direct PostgREST query to enumerate other clients' jobs.
create function app.is_groomer_member() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.memberships m join public.roles r on r.id=m.role_id
    where m.user_id=app.fn_current_user_id() and m.organization_id=app.fn_active_organization()
      and m.status='active' and m.deleted_at is null and r.name='Groomer');
$$;
create function app.groomer_assigned_job_pet(p_job_pet uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.grooming_job_pets gjp
    join public.resources r on r.id=gjp.assigned_resource_id and r.organization_id=gjp.organization_id
    join public.memberships m on m.id=r.membership_id and m.organization_id=r.organization_id
    where gjp.id=p_job_pet and gjp.organization_id=app.fn_active_organization()
      and m.user_id=app.fn_current_user_id() and m.status='active' and m.deleted_at is null
      and r.status='active' and r.deleted_at is null);
$$;
create function app.groomer_assigned_booking(p_booking uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.grooming_job_pets gjp
    where gjp.grooming_job_id=p_booking and gjp.organization_id=app.fn_active_organization()
      and app.groomer_assigned_job_pet(gjp.id));
$$;
create function app.groomer_assigned_pet(p_pet uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.grooming_job_pets gjp
    where gjp.pet_id=p_pet and gjp.organization_id=app.fn_active_organization()
      and app.groomer_assigned_job_pet(gjp.id));
$$;
create function app.groomer_assigned_customer(p_customer uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.bookings b where b.customer_id=p_customer
    and b.organization_id=app.fn_active_organization() and app.groomer_assigned_booking(b.id));
$$;
revoke all on function app.is_groomer_member() from public;
revoke all on function app.groomer_assigned_job_pet(uuid) from public;
revoke all on function app.groomer_assigned_booking(uuid) from public;
revoke all on function app.groomer_assigned_pet(uuid) from public;
revoke all on function app.groomer_assigned_customer(uuid) from public;
grant execute on function app.is_groomer_member() to authenticated;
grant execute on function app.groomer_assigned_job_pet(uuid) to authenticated;
grant execute on function app.groomer_assigned_booking(uuid) to authenticated;
grant execute on function app.groomer_assigned_pet(uuid) to authenticated;
grant execute on function app.groomer_assigned_customer(uuid) to authenticated;
create policy groomer_own_bookings on public.bookings as restrictive for select to authenticated
  using (not app.is_groomer_member() or app.groomer_assigned_booking(id));
create policy groomer_own_booking_updates on public.bookings as restrictive for update to authenticated
  using (not app.is_groomer_member() or app.groomer_assigned_booking(id))
  with check (not app.is_groomer_member() or app.groomer_assigned_booking(id));
create policy groomer_own_customers on public.customers as restrictive for select to authenticated
  using (not app.is_groomer_member() or app.groomer_assigned_customer(id));
create policy groomer_own_pets on public.pets as restrictive for select to authenticated
  using (not app.is_groomer_member() or app.groomer_assigned_pet(id));
create policy groomer_own_customer_addresses on public.customer_addresses as restrictive for select to authenticated
  using (not app.is_groomer_member() or app.groomer_assigned_customer(customer_id));
create policy groomer_own_job_pets on public.grooming_job_pets as restrictive for select to authenticated
  using (not app.is_groomer_member() or app.groomer_assigned_job_pet(id));
create policy groomer_own_job_pet_services on public.grooming_job_pet_services as restrictive for select to authenticated
  using (not app.is_groomer_member() or app.groomer_assigned_job_pet(grooming_job_pet_id));

create function app.set_operro_organization_status(p_org uuid,p_status text,p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_status not in ('active','suspended') then raise exception 'invalid_status' using errcode='22023'; end if;
  update public.organizations set status=p_status,
    settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{platform_billing}',
      jsonb_build_object('reason',left(btrim(coalesce(p_reason,'')),500),'changed_at',now(),'changed_by',auth.uid()),true)
  where id=p_org and deleted_at is null and status in ('trial','active','suspended');
  if not found then raise exception 'organization_not_found' using errcode='22023'; end if;
  if p_status='suspended' then
    update public.subscriptions set status='paused' where organization_id=p_org and deleted_at is null and status in ('trialing','active','past_due');
  else
    update public.subscriptions set status='active',current_period_end=greatest(coalesce(current_period_end,now()),now()+interval '30 days')
      where organization_id=p_org and deleted_at is null and status='paused';
  end if;
end;
$$;
revoke all on function app.set_operro_organization_status(uuid,text,text) from public;
grant execute on function app.set_operro_organization_status(uuid,text,text) to authenticated;

-- Manual subscription billing belongs to Operro, not the tenant workspace.
-- Each month has a reviewable amount, due date and paid/unpaid state.
create table public.platform_billing_periods (
  organization_id uuid not null references public.organizations(id),
  period_month date not null,
  amount_idr numeric(14,2) not null check (amount_idr >= 0),
  due_date date not null,
  status text not null check (status in ('awaiting_payment','paid','overdue','waived')),
  paid_at timestamptz,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (organization_id,period_month),
  constraint chk_platform_billing_month check (period_month=date_trunc('month',period_month)::date)
);
alter table public.platform_billing_periods enable row level security;
revoke all on public.platform_billing_periods from anon,authenticated;

create function app.set_operro_billing_period(p_org uuid,p_month date,p_amount numeric,p_due date,p_status text,p_note text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_month is null or p_month<>date_trunc('month',p_month)::date or p_amount is null or p_amount<0
    or p_due is null or p_status not in ('awaiting_payment','paid','overdue','waived')
    or not exists(select 1 from public.organizations where id=p_org and deleted_at is null)
  then raise exception 'invalid_billing_period' using errcode='22023'; end if;
  insert into public.platform_billing_periods(organization_id,period_month,amount_idr,due_date,status,paid_at,note,updated_by)
    values(p_org,p_month,p_amount,p_due,p_status,case when p_status='paid' then now() end,left(p_note,500),auth.uid())
  on conflict (organization_id,period_month) do update set amount_idr=excluded.amount_idr,due_date=excluded.due_date,
    status=excluded.status,paid_at=case when excluded.status='paid' then coalesce(public.platform_billing_periods.paid_at,now()) else null end,
    note=excluded.note,updated_at=now(),updated_by=auth.uid();
end $$;
revoke all on function app.set_operro_billing_period(uuid,date,numeric,date,text,text) from public;
grant execute on function app.set_operro_billing_period(uuid,date,numeric,date,text,text) to authenticated;

create function app.list_operro_billing(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('month',period_month,'amount',amount_idr,'due',due_date,
    'status',status,'paid_at',paid_at,'note',note) order by period_month desc)
    from public.platform_billing_periods where organization_id=p_org),'[]'::jsonb);
end $$;
revoke all on function app.list_operro_billing(uuid) from public;
grant execute on function app.list_operro_billing(uuid) to authenticated;

create function app.set_organization_member_role(p_org uuid,p_email text,p_role text,p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_role uuid; v_member public.memberships; v_owner_count integer;
begin
  if not app.is_business_owner(p_org) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_role not in ('Pemilik','Admin','Bantuan Operro','Groomer') or p_status not in ('active','suspended')
    or (p_role in ('Pemilik','Bantuan Operro') and not app.is_operro_owner())
  then raise exception 'invalid_role' using errcode='22023'; end if;
  select id into v_user from public.users where lower(email)=lower(btrim(p_email)) and deleted_at is null;
  select id into v_role from public.roles where organization_id=p_org and name=p_role and deleted_at is null;
  select * into v_member from public.memberships where organization_id=p_org and user_id=v_user and deleted_at is null for update;
  if v_user is null or v_role is null or v_member.id is null then raise exception 'member_not_found' using errcode='22023'; end if;
  if not app.is_operro_owner() and exists(select 1 from public.roles where id=v_member.role_id and name in ('Pemilik','Bantuan Operro')) then
    raise exception 'protected_member' using errcode='42501';
  end if;
  if exists(select 1 from public.roles where id=v_member.role_id and name='Pemilik') and (p_role<>'Pemilik' or p_status<>'active') then
    select count(*) into v_owner_count from public.memberships m join public.roles r on r.id=m.role_id
    where m.organization_id=p_org and m.status='active' and m.deleted_at is null and r.name='Pemilik';
    if v_owner_count<=1 then raise exception 'last_owner' using errcode='22023'; end if;
  end if;
  update public.memberships set role_id=v_role,status=p_status where id=v_member.id;
  update public.platform_access_invitations set status='revoked'
    where organization_id=p_org and email=lower(btrim(p_email)) and status='pending';
end;
$$;
revoke all on function app.set_organization_member_role(uuid,text,text,text) from public;
grant execute on function app.set_organization_member_role(uuid,text,text,text) to authenticated;

-- The business owner may edit the Admin checklist, but cannot grant role/user
-- administration or platform-only powers. The Operro support role is immutable.
create function app.set_business_admin_permissions(p_org uuid,p_keys text[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_role uuid;
begin
  if not app.is_business_owner(p_org) then raise exception 'not_authorized' using errcode='42501'; end if;
  if cardinality(p_keys)>80 or exists(
    select 1 from unnest(p_keys) k where k in ('roles.manage','users.manage')
      or not exists(select 1 from public.permissions p where p.key=k and p.deleted_at is null)
  ) then raise exception 'invalid_permissions' using errcode='22023'; end if;
  select id into v_role from public.roles where organization_id=p_org and name='Admin' and deleted_at is null for update;
  if v_role is null then raise exception 'admin_role_not_found' using errcode='22023'; end if;
  delete from public.role_permissions where organization_id=p_org and role_id=v_role;
  insert into public.role_permissions(organization_id,role_id,permission_id)
  select p_org,v_role,p.id from public.permissions p where p.key=any(p_keys) and p.deleted_at is null;
end;
$$;
revoke all on function app.set_business_admin_permissions(uuid,text[]) from public;
grant execute on function app.set_business_admin_permissions(uuid,text[]) to authenticated;

create function app.list_organization_access(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_business_owner(p_org) then raise exception 'not_authorized' using errcode='42501'; end if;
  return jsonb_build_object(
    'members',coalesce((select jsonb_agg(jsonb_build_object('email',u.email,'role',r.name,'status',m.status) order by u.email)
      from public.memberships m join public.users u on u.id=m.user_id join public.roles r on r.id=m.role_id
      where m.organization_id=p_org and m.deleted_at is null), '[]'::jsonb),
    'admin_keys',coalesce((select jsonb_agg(p.key order by p.key)
      from public.role_permissions rp join public.roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
      where r.organization_id=p_org and r.name='Admin'),'[]'::jsonb),
    'options',coalesce((select jsonb_agg(jsonb_build_object('key',p.key,'description',p.description) order by p.key)
      from public.permissions p where p.deleted_at is null and p.key not in ('roles.manage','users.manage')),'[]'::jsonb)
  );
end;
$$;
revoke all on function app.list_organization_access(uuid) from public;
grant execute on function app.list_organization_access(uuid) to authenticated;

create function app.list_access_invitations(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_business_owner(p_org) then raise exception 'not_authorized' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('email',i.email,'role',i.role_name,'status',i.status,'created_at',i.created_at,'expires_at',i.expires_at) order by i.created_at desc)
    from (select * from public.platform_access_invitations where organization_id=p_org order by created_at desc limit 30) i),'[]'::jsonb);
end;
$$;
revoke all on function app.list_access_invitations(uuid) from public;
grant execute on function app.list_access_invitations(uuid) to authenticated;

create function app.platform_storage_snapshot() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_files bigint; v_bytes bigint; v_db bigint;
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode='42501'; end if;
  select count(*),coalesce(sum(case when (o.metadata->>'size') ~ '^\d+$' then (o.metadata->>'size')::bigint else 0 end),0)
    into v_files,v_bytes from storage.objects o;
  select pg_catalog.pg_database_size(pg_catalog.current_database()) into v_db;
  return jsonb_build_object('file_count',v_files,'file_bytes',v_bytes,'database_bytes',v_db,'measured_at',now());
end;
$$;
revoke all on function app.platform_storage_snapshot() from public;
grant execute on function app.platform_storage_snapshot() to authenticated;

-- Membership and permission edits must pass the guarded RPCs above. The
-- pre-existing table grants would otherwise let a business owner alter the
-- platform helper role or bypass the last-owner protection directly.
revoke insert, update, delete on public.memberships from authenticated;
revoke insert, update, delete on public.role_permissions from authenticated;
revoke insert, update, delete on public.roles from authenticated;
-- Billing and organization lifecycle belong to the Operro platform owner.
revoke insert, update, delete on public.subscriptions from authenticated;
revoke insert, update, delete on public.organizations from authenticated;

create function app.is_operational_organization(p_org uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.organizations o where o.id=p_org
    and o.status in ('trial','active') and o.deleted_at is null);
$$;
revoke all on function app.is_operational_organization(uuid) from public;
grant execute on function app.is_operational_organization(uuid) to authenticated;
create policy organizations_operational_read on public.organizations as restrictive for select to authenticated
  using (app.is_platform_admin() or app.is_operational_organization(id));
create policy memberships_operational_read on public.memberships as restrictive for select to authenticated
  using (app.is_platform_admin() or app.is_operational_organization(organization_id));

-- Public registration links become unavailable while the workspace is paused.
create or replace function app.get_customer_onboarding_link(p_token text)
returns table(valid boolean,status text,expires_at timestamptz,organization_name text,organization_id uuid)
language sql security definer set search_path=app,public,extensions as $$
  select (l.status='active' and l.expires_at>now() and o.status in ('trial','active') and o.deleted_at is null),
         case when o.status not in ('trial','active') or o.deleted_at is not null then 'unavailable'
              when l.expires_at<=now() and l.status='active' then 'expired' else l.status end,
         l.expires_at,o.name,l.organization_id
  from public.customer_onboarding_links l join public.organizations o on o.id=l.organization_id
  where l.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') limit 1
$$;

create or replace function public.get_customer_onboarding_link(p_token text)
returns table(valid boolean,status text,expires_at timestamptz,organization_name text,organization_id uuid)
language sql volatile security definer set search_path = '' as $$
  select * from app.get_customer_onboarding_link(p_token)
$$;

create or replace function app.can_upload_onboarding_style(p_org text,p_hash text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.customer_onboarding_links l
    join public.organizations o on o.id=l.organization_id
    where l.organization_id::text=p_org and l.token_hash=p_hash
      and l.status='active' and l.expires_at>now()
      and o.status in ('trial','active') and o.deleted_at is null)
$$;

create or replace function app.submit_customer_onboarding(p_token text,p_payload jsonb)
returns uuid language plpgsql security definer set search_path=app,public,extensions as $$
declare v_link public.customer_onboarding_links; v_id uuid; v_pets jsonb;
begin
  select l.* into v_link from public.customer_onboarding_links l
    join public.organizations o on o.id=l.organization_id and o.status in ('trial','active') and o.deleted_at is null
    where l.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update of l;
  if not found or v_link.status<>'active' then raise exception 'link_not_available' using errcode='P0002'; end if;
  if v_link.expires_at<=now() then raise exception 'link_expired' using errcode='22023'; end if;
  v_pets:=p_payload->'pets';
  if jsonb_typeof(p_payload)<>'object' or length(trim(coalesce(p_payload->>'customerName','')))<2 or length(trim(coalesce(p_payload->>'phone','')))<7
     or jsonb_typeof(v_pets)<>'array' or jsonb_array_length(v_pets)<1 or jsonb_array_length(v_pets)>5 then
    raise exception 'invalid_submission' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(v_pets) p where length(trim(coalesce(p->>'name','')))<1) then raise exception 'invalid_pet' using errcode='22023'; end if;
  insert into public.customer_onboarding_submissions(organization_id,link_id,payload) values(v_link.organization_id,v_link.id,p_payload) returning id into v_id;
  update public.customer_onboarding_links set status='submitted' where id=v_link.id;
  return v_id;
end $$;

commit;
