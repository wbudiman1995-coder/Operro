-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0011_security_rls_capabilities
-- Milestone        8B — Security / RLS (Capability Enforcement)
-- Purpose          Complete the authorization model: seed the domain-owned
--                  permission catalog (Rule 46), and add RESTRICTIVE
--                  (AND-layered) RLS policies enforcing MODULE entitlement
--                  and READ/WRITE-separated PERMISSIONS on top of the 8A
--                  isolation layer (Rules 43/45). Add an explainability
--                  function (Rule 47). All checks are live/stateless (48).
-- Dependencies     0002 (rbac), 0003 (has_module), 0010 (8A helpers/policies).
-- Objects Created  Seed: 'membership' module + domain permissions.
--                  app.explain_authorization(text,text,uuid)
--                  RESTRICTIVE policies on tenant tables.
-- RLS Policies     restrictive module gate (FOR ALL); restrictive read
--                  permission (FOR SELECT); restrictive write permission
--                  (FOR INSERT/UPDATE/DELETE). Platform admin bypasses all.
-- Breaking Changes None — restrictive policies only further constrain.
-- Rollback         DROP the restrictive policies + explain fn + seeds.
-- Notes            Trigger-populated ledgers restrict DIRECT user writes to
--                  platform-admin; the triggers (SECURITY DEFINER) bypass RLS
--                  and continue to populate them.
-- =====================================================================


-- =====================================================================
-- SECTION 000 — Make side-effect trigger fns SECURITY DEFINER
-- =====================================================================
-- Under RLS, a trigger that writes to a system/protected table (audit log,
-- level/ledger caches, order totals) would run as the calling user and be
-- denied. These must run as owner (definer) to preserve invariants while the
-- user stays fully constrained. Bodies unchanged; only definer + search_path.

create or replace function app.tg_write_audit()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_id uuid; v_old jsonb; v_new jsonb;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_org := coalesce((v_old ->> 'organization_id')::uuid, app.fn_active_organization());
    v_id  := (v_old ->> 'id')::uuid;
  else
    v_new := to_jsonb(new);
    v_org := coalesce((v_new ->> 'organization_id')::uuid, app.fn_active_organization());
    v_id  := (v_new ->> 'id')::uuid;
    if tg_op = 'UPDATE' then v_old := to_jsonb(old); end if;
  end if;
  insert into app.audit_log (organization_id, actor_id, action, entity_table, entity_id, diff)
  values (v_org, app.fn_current_user_id(), tg_op, tg_table_name, v_id,
          jsonb_strip_nulls(jsonb_build_object('old', v_old, 'new', v_new)));
  return case when tg_op = 'DELETE' then old else new end;
end; $$;

create or replace function public.tg_inventory_apply_movement()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  insert into public.inventory_levels (organization_id, branch_id, product_id, quantity, updated_at)
  values (new.organization_id, new.branch_id, new.product_id, new.quantity, now())
  on conflict (organization_id, branch_id, product_id)
  do update set quantity = public.inventory_levels.quantity + excluded.quantity, updated_at = now();
  return new;
end; $$;

create or replace function public.fn_consume_service_inventory(p_booking uuid, p_org uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_branch uuid; v_service uuid;
begin
  if exists (select 1 from public.inventory_movements
             where organization_id = p_org and reference_booking_id = p_booking and movement_type = 'consumption') then
    return;
  end if;
  select branch_id, service_id into v_branch, v_service
  from public.bookings where id = p_booking and organization_id = p_org;
  if v_service is null then return; end if;
  insert into public.inventory_movements
    (organization_id, branch_id, product_id, movement_type, quantity, reference_booking_id, notes)
  select p_org, v_branch, sp.product_id, 'consumption', -sp.quantity, p_booking, 'auto: service completion'
  from public.service_products sp
  where sp.organization_id = p_org and sp.service_id = v_service;
end; $$;

create or replace function public.tg_orders_recompute_totals()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_order uuid; v_org uuid;
begin
  v_order := coalesce(new.order_id, old.order_id);
  v_org   := coalesce(new.organization_id, old.organization_id);
  update public.orders o set
    subtotal = t.sub, discount_total = t.disc, tax_total = t.tax,
    total = t.sub - t.disc + t.tax, updated_at = now()
  from (select coalesce(sum(unit_price*quantity),0) sub, coalesce(sum(discount_amount),0) disc,
               coalesce(sum(tax_amount),0) tax
        from public.order_items where order_id = v_order and organization_id = v_org) t
  where o.id = v_order and o.organization_id = v_org;
  return null;
end; $$;

create or replace function public.tg_invoice_ledger()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if tg_op = 'INSERT' and new.status = 'issued' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, invoice_id, occurred_at)
    values (new.organization_id, new.branch_id, 'invoice_issued', new.total, new.currency, new.id, new.issued_at);
  elsif tg_op = 'UPDATE' and new.status = 'void' and old.status <> 'void' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, invoice_id, occurred_at)
    values (new.organization_id, new.branch_id, 'invoice_void', -old.total, new.currency, new.id, now());
  end if;
  return null;
end; $$;

create or replace function public.tg_payment_ledger()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status = 'succeeded' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, payment_id, occurred_at)
    values (new.organization_id, new.branch_id, 'payment_received', new.amount, new.currency, new.id, new.paid_at);
  end if;
  return null;
end; $$;

create or replace function public.tg_refund_ledger()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status = 'succeeded' then
    insert into public.financial_ledger (organization_id, entry_type, amount, refund_id, occurred_at)
    values (new.organization_id, 'refund_issued', -new.amount, new.id, new.refunded_at);
  end if;
  return null;
end; $$;

create or replace function public.tg_payroll_ledger()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status = 'paid' and old.status <> 'paid' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, payroll_run_id, occurred_at)
    values (new.organization_id, new.branch_id, 'payroll_paid', -new.total_net, new.currency, new.id, coalesce(new.paid_at, now()));
  end if;
  return null;
end; $$;

create or replace function public.tg_expense_ledger()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status = 'reimbursed' and old.status <> 'reimbursed' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, expense_id, occurred_at)
    values (new.organization_id, new.branch_id, 'expense_paid', -new.amount, new.currency, new.id, coalesce(new.reimbursed_at, now()));
  end if;
  return null;
end; $$;

create or replace function public.fn_accrue_commission(p_booking uuid, p_org uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_service uuid; v_base numeric(14,2); v_ccy text; v_member uuid; d jsonb;
begin
  if exists (select 1 from public.commission_entries where organization_id = p_org and reference_booking_id = p_booking) then
    return;
  end if;
  select service_id, coalesce(price_snapshot,0), coalesce(currency,'USD') into v_service, v_base, v_ccy
  from public.bookings where id = p_booking and organization_id = p_org;
  select r.membership_id into v_member
  from public.booking_resources br
  join public.resources r on r.id = br.resource_id and r.organization_id = br.organization_id
  where br.booking_id = p_booking and br.organization_id = p_org and r.membership_id is not null
  order by br.created_at limit 1;
  if v_member is null then return; end if;
  d := app.resolve_commission(p_org, v_service, v_base);
  if (d->>'commission_amount')::numeric <= 0 then return; end if;
  insert into public.commission_entries
    (organization_id, membership_id, reference_booking_id, base_amount, rate_snapshot, commission_amount, currency)
  values (p_org, v_member, p_booking, v_base, d, (d->>'commission_amount')::numeric, v_ccy);
end; $$;

create or replace function public.fn_consume_package_session(p_booking uuid, p_org uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_customer uuid; v_service uuid; v_pkg uuid;
begin
  if exists (select 1 from public.customer_package_ledger
             where organization_id = p_org and reference_booking_id = p_booking and reason = 'consumption') then
    return;
  end if;
  select customer_id, service_id into v_customer, v_service
  from public.bookings where id = p_booking and organization_id = p_org;
  if v_customer is null then return; end if;
  select cp.id into v_pkg from public.customer_packages cp
  where cp.organization_id = p_org and cp.customer_id = v_customer and cp.status = 'active'
    and cp.sessions_remaining > 0 and (cp.expires_at is null or cp.expires_at > now())
    and (cp.service_id is null or cp.service_id = v_service)
  order by cp.expires_at nulls last, cp.purchased_at limit 1;
  if v_pkg is null then return; end if;
  insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, reference_booking_id, notes)
  values (p_org, v_pkg, -1, 'consumption', p_booking, 'auto: booking completion');
  update public.customer_packages set status = 'exhausted'
   where id = v_pkg and organization_id = p_org and sessions_remaining <= 0;
end; $$;

create or replace function public.tg_package_apply_ledger()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  update public.customer_packages set sessions_remaining = sessions_remaining + new.delta, updated_at = now()
   where id = new.customer_package_id and organization_id = new.organization_id;
  return new;
end; $$;

create or replace function public.tg_loyalty_apply_ledger()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  update public.loyalty_accounts set points_balance = points_balance + new.delta, updated_at = now()
   where id = new.loyalty_account_id and organization_id = new.organization_id;
  return new;
end; $$;

create or replace function public.tg_wallet_apply_ledger()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  update public.wallet_accounts set balance = balance + new.delta, updated_at = now()
   where id = new.wallet_account_id and organization_id = new.organization_id;
  return new;
end; $$;

create or replace function public.tg_bookings_release_resources()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status in ('canceled','no_show') and old.status not in ('canceled','no_show') then
    update public.booking_resources set is_active = false where booking_id = new.id and organization_id = new.organization_id;
  elsif old.status in ('canceled','no_show') and new.status not in ('canceled','no_show') then
    update public.booking_resources set is_active = true where booking_id = new.id and organization_id = new.organization_id;
  end if;
  return new;
end; $$;

create or replace function public.tg_bookres_set_exclusive()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  select (r.capacity = 1) into new.is_exclusive
  from public.resources r where r.id = new.resource_id and r.organization_id = new.organization_id;
  if new.is_exclusive is null then new.is_exclusive := true; end if;
  return new;
end; $$;


-- =====================================================================
-- SECTION 001 — Seed 'membership' module + domain-owned permissions
-- =====================================================================
insert into public.modules (key,name,category,sort_order) values
  ('membership','Membership & Programs','commercial',25)
on conflict (key) do nothing;

insert into public.permissions (key,resource,action,description) values
  ('customer.read','customer','read','View customers and pets'),
  ('customer.manage','customer','manage','Create/edit customers and pets'),
  ('booking.read','booking','read','View bookings'),
  ('booking.create','booking','create','Create bookings'),
  ('booking.update','booking','update','Edit bookings'),
  ('booking.delete','booking','delete','Delete bookings'),
  ('booking.cancel','booking','cancel','Cancel bookings (app-layer capability)'),
  ('booking.complete','booking','complete','Complete bookings (app-layer capability)'),
  ('resource.manage','resource','manage','Manage resources & availability'),
  ('service.manage','service','manage','Manage the service catalog'),
  ('product.manage','product','manage','Manage the product catalog'),
  ('inventory.read','inventory','read','View inventory'),
  ('inventory.adjust','inventory','adjust','Record inventory movements'),
  ('inventory.manage','inventory','manage','Manage inventory configuration'),
  ('order.read','order','read','View orders'),
  ('order.manage','order','manage','Create/edit orders'),
  ('finance.read','finance','read','View financial records'),
  ('invoice.issue','invoice','issue','Issue invoices'),
  ('payment.manage','payment','manage','Record payments and refunds'),
  ('expense.manage','expense','manage','Manage expenses'),
  ('finance.manage','finance','manage','Manage tax and financial config'),
  ('payroll.read','payroll','read','View payroll and commission'),
  ('payroll.manage','payroll','manage','Manage compensation and rules'),
  ('payroll.approve','payroll','approve','Approve payroll runs'),
  ('membership.read','membership','read','View customer programs'),
  ('membership.manage','membership','manage','Manage customer programs'),
  ('task.manage','task','manage','Manage tasks'),
  ('sop.manage','sop','manage','Manage SOP templates'),
  ('roles.manage','roles','manage','Manage roles and permissions')
on conflict (key) do nothing;


-- =====================================================================
-- SECTION 002 — Explainability (Rule 47)
-- =====================================================================
create or replace function app.explain_authorization(
  p_module text default null, p_perm text default null, p_branch uuid default null)
returns jsonb security definer set search_path = app, public
language plpgsql stable as $$
begin
  if app.is_platform_admin() then return jsonb_build_object('allowed',true,'reason','platform_admin'); end if;
  if not app.has_membership() then return jsonb_build_object('allowed',false,'reason','no_active_membership'); end if;
  if p_module is not null and not app.has_module(p_module) then
    return jsonb_build_object('allowed',false,'reason','missing_module:'||p_module); end if;
  if p_branch is not null and not app.has_branch(p_branch) then
    return jsonb_build_object('allowed',false,'reason','wrong_branch'); end if;
  if p_perm is not null and not app.has_permission(p_perm) then
    return jsonb_build_object('allowed',false,'reason','missing_permission:'||p_perm); end if;
  return jsonb_build_object('allowed',true,'reason','ok');
end; $$;


-- =====================================================================
-- SECTION 003 — Restrictive capability policies (AND-layered over 8A)
-- =====================================================================
-- Mapping: (table, module_gate, read_perm, write_perm, admin_only_write)
-- admin_only_write=true => direct user writes blocked; triggers (definer) bypass.
do $$
declare r record; wcheck text;
begin
  for r in
    select * from (values
      -- identity/config (no module gate)
      ('branches',                null,        null,            'branches.manage', false),
      ('roles',                   null,        null,            'roles.manage',    false),
      ('role_permissions',        null,        null,            'roles.manage',    false),
      ('membership_branch_access',null,        null,            'users.manage',    false),
      ('subscriptions',           null,        null,            'settings.manage', false),
      ('organization_modules',    null,        null,            'settings.manage', false),
      ('organization_features',   null,        null,            'settings.manage', false),
      -- commercial
      ('customers',               'crm',       null,            'customer.manage', false),
      ('pets',                    'crm',       null,            'customer.manage', false),
      ('service_catalog',         'scheduling',null,            'service.manage',  false),
      ('product_catalog',         'pos',       null,            'product.manage',  false),
      -- operations
      ('bookings',                'scheduling','booking.read',  'booking.create',  false),
      ('booking_recurrence',      'scheduling',null,            'booking.update',  false),
      ('booking_resources',       'scheduling',null,            'booking.update',  false),
      ('grooming_jobs',           'scheduling',null,            'booking.update',  false),
      ('boarding_stays',          'scheduling',null,            'booking.update',  false),
      ('resources',               'scheduling',null,            'resource.manage', false),
      ('resource_availability',   'scheduling',null,            'resource.manage', false),
      ('tasks',                   'scheduling',null,            'task.manage',     false),
      ('sop_templates',           'scheduling',null,            'sop.manage',      false),
      ('inventory_movements',     'inventory', 'inventory.read','inventory.adjust',false),
      ('inventory_levels',        'inventory', 'inventory.read',null,              true),
      ('service_products',        'inventory', null,            'inventory.manage',false),
      -- financial
      ('orders',                  'pos',       'order.read',    'order.manage',    false),
      ('order_items',             'pos',       'order.read',    'order.manage',    false),
      ('invoices',                'finance',   'finance.read',  'invoice.issue',   false),
      ('invoice_lines',           'finance',   'finance.read',  'invoice.issue',   false),
      ('payments',                'finance',   'finance.read',  'payment.manage',  false),
      ('refunds',                 'finance',   'finance.read',  'payment.manage',  false),
      ('tax_rates',               'finance',   null,            'finance.manage',  false),
      ('financial_ledger',        'finance',   'finance.read',  null,              true),
      ('commission_rules',        'payroll',   'payroll.read',  'payroll.manage',  false),
      ('commission_entries',      'payroll',   'payroll.read',  'payroll.approve', false),
      ('staff_compensation',      'payroll',   'payroll.read',  'payroll.manage',  false),
      ('payroll_runs',            'payroll',   'payroll.read',  'payroll.approve', false),
      ('payroll_items',           'payroll',   'payroll.read',  'payroll.approve', false),
      ('expenses',                'finance',   'finance.read',  'expense.manage',  false),
      -- customer programs
      ('membership_plans',        'membership',null,            'membership.manage',false),
      ('customer_memberships',    'membership','membership.read','membership.manage',false),
      ('packages',                'membership',null,            'membership.manage',false),
      ('customer_packages',       'membership','membership.read','membership.manage',false),
      ('customer_package_ledger', 'membership','membership.read','membership.manage',false),
      ('loyalty_accounts',        'membership','membership.read','membership.manage',false),
      ('loyalty_ledger',          'membership','membership.read','membership.manage',false),
      ('wallet_accounts',         'membership','membership.read','membership.manage',false),
      ('wallet_ledger',           'membership','membership.read','membership.manage',false),
      ('referrals',               'membership','membership.read','membership.manage',false)
    ) as m(tbl, module, rperm, wperm, admin_write)
  loop
    -- module entitlement gate (restrictive, all commands)
    if r.module is not null then
      execute format($f$
        create policy %1$s_module_gate on public.%1$s as restrictive for all
        using (app.is_platform_admin() or app.has_module(%2$L))
        with check (app.is_platform_admin() or app.has_module(%2$L));
      $f$, r.tbl, r.module);
    end if;

    -- read capability (restrictive, select only)
    if r.rperm is not null then
      execute format($f$
        create policy %1$s_read_cap on public.%1$s as restrictive for select
        using (app.is_platform_admin() or app.has_permission(%2$L));
      $f$, r.tbl, r.rperm);
    end if;

    -- write capability (restrictive; separate per command — Rule 45)
    if r.admin_write then
      wcheck := 'app.is_platform_admin()';
    elsif r.wperm is not null then
      wcheck := format('(app.is_platform_admin() or app.has_permission(%L))', r.wperm);
    else
      wcheck := null;
    end if;

    if wcheck is not null then
      execute format('create policy %1$s_write_ins on public.%1$s as restrictive for insert with check (%2$s);', r.tbl, wcheck);
      execute format('create policy %1$s_write_upd on public.%1$s as restrictive for update using (%2$s) with check (%2$s);', r.tbl, wcheck);
      execute format('create policy %1$s_write_del on public.%1$s as restrictive for delete using (%2$s);', r.tbl, wcheck);
    end if;
  end loop;
end $$;

-- =====================================================================
-- END 0011_security_rls_capabilities
-- =====================================================================
