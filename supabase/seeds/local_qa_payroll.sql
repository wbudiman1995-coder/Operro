-- Groomer membership + resource link + payroll data, on top of homepaw_demo.sql's org/role.
do $$
declare
  v_org uuid := 'd0000000-0000-4000-8000-000000000001';
  v_role uuid := 'e0000000-0000-4000-8000-000000000011';
  v_groomer_id uuid := 'e0000000-0000-4000-8000-000000000002';
  v_groomer_membership uuid := 'e0000000-0000-4000-8000-000000000010';
  v_andi_resource uuid := 'd0000000-0000-4000-8000-000000000201';
  v_branch uuid := 'd0000000-0000-4000-8000-000000000010';
begin
  insert into public.roles (id, organization_id, name, description, is_system)
  values (v_role, v_org, 'Groomer', 'Akses operasional terbatas untuk groomer', true)
  on conflict (id) do update set name = excluded.name, description = excluded.description, deleted_at = null;

  delete from public.role_permissions where role_id = v_role and organization_id = v_org;
  insert into public.role_permissions (role_id, permission_id, organization_id)
  select v_role, p.id, v_org
  from public.permissions p
  where p.key in ('booking.read', 'booking.update', 'booking.complete')
  on conflict do nothing;

  insert into public.memberships (id, user_id, organization_id, role_id, status)
  values (v_groomer_membership, v_groomer_id, v_org, v_role, 'active')
  on conflict (user_id, organization_id) do update set role_id = excluded.role_id, status = 'active', deleted_at = null;

  insert into public.membership_branch_access (membership_id, branch_id, organization_id)
  values (v_groomer_membership, v_branch, v_org)
  on conflict (membership_id, branch_id) do update set organization_id = excluded.organization_id;

  update public.resources set membership_id = v_groomer_membership
  where id = v_andi_resource and organization_id = v_org;

  insert into public.staff_compensation (organization_id, membership_id, pay_type, base_amount, currency, effective_from, is_active)
  values (v_org, v_groomer_membership, 'salary', 3000000, 'IDR', current_date, true)
  on conflict do nothing;
end $$;

-- Note: staff_compensation only exists for the groomer QA login (Andi). Sari/Bima are
-- resources with no membership_id in homepaw_demo.sql, and staff_compensation.membership_id
-- is not-null — they can't be paid without a membership, which is a real gap this seed
-- doesn't invent an answer for, not an oversight.
