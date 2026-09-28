-- Payroll engine (section 32) demo config, on top of homepaw_demo.sql + local_qa_payroll.sql.
-- Tags canonical payroll roles onto services (never inferred from name at query time), seeds an
-- org-level payroll_cycle_settings row matching HomePaw's shipped defaults, and gives the QA
-- groomer (Andi) a couple of deliberate per-groomer overrides so local/browser QA has something
-- to look at beyond "everything inherits the default".
do $$
declare
  v_org uuid := 'd0000000-0000-4000-8000-000000000001';
  v_groomer_membership uuid := 'e0000000-0000-4000-8000-000000000010';
  v_basic_grooming uuid := 'd0000000-0000-4000-8000-000000000101';
begin
  update public.service_catalog set payroll_role = 'basic_grooming'
   where organization_id = v_org and id = v_basic_grooming;

  insert into public.service_catalog
    (id, organization_id, name, description, category, duration_minutes, base_price, currency,
     required_photos, fulfillment_modes, is_active, payroll_role, metadata)
  values
    ('d0000000-0000-4000-8000-000000000105', v_org, 'Styling', 'Potongan gaya/tematik setelah Basic Grooming', 'grooming', 30, 100000, 'IDR', 1, '["home","in_store"]', true, 'styling', '{"demo_seed":"payroll_s32"}'),
    ('d0000000-0000-4000-8000-000000000106', v_org, 'Botak', 'Cukur pendek penuh', 'grooming', 20, 60000, 'IDR', 1, '["home","in_store"]', true, 'botak', '{"demo_seed":"payroll_s32"}')
  on conflict (organization_id, name) do update set payroll_role = excluded.payroll_role;

  insert into public.payroll_cycle_settings
    (organization_id, cycle_start_day, weekly_salary_amount_default, no_late_amount_default,
     no_sick_amount_default, styling_tiers_default, botak_amount_default, per_pet_amount_default,
     per_pet_size_matrix_default, daily_amount_default, retention_amount_per_month_default,
     retention_term_months_default)
  values
    (v_org, 26, 200000, 300000, 300000,
     '[{"min_jobs":1,"pct":10},{"min_jobs":17,"pct":20}]'::jsonb,
     10000, 20000, '{}'::jsonb, 30000, 500000, 24)
  on conflict (organization_id) do update set
    cycle_start_day = excluded.cycle_start_day,
    weekly_salary_amount_default = excluded.weekly_salary_amount_default,
    no_late_amount_default = excluded.no_late_amount_default,
    no_sick_amount_default = excluded.no_sick_amount_default,
    styling_tiers_default = excluded.styling_tiers_default,
    botak_amount_default = excluded.botak_amount_default,
    per_pet_amount_default = excluded.per_pet_amount_default,
    daily_amount_default = excluded.daily_amount_default,
    retention_amount_per_month_default = excluded.retention_amount_per_month_default,
    retention_term_months_default = excluded.retention_term_months_default;

  -- QA groomer (Andi): weekly salary + no-late bonus turned on, everything else inherits defaults.
  insert into public.staff_payroll_settings
    (organization_id, membership_id, weekly_salary_enabled, no_late_enabled, no_sick_enabled)
  values (v_org, v_groomer_membership, true, true, true)
  on conflict (organization_id, membership_id) do update set
    weekly_salary_enabled = excluded.weekly_salary_enabled,
    no_late_enabled = excluded.no_late_enabled,
    no_sick_enabled = excluded.no_sick_enabled;
end $$;
