-- Row-level fingerprints of every table whose data must survive SB-01..SB-04
-- untouched. One line per table: name|row count|md5 over the full row JSON
-- (sorted). Columns that the migrations ADD are excluded so the comparison is
-- over exactly the values that existed before. updated_at is included, so any
-- UPDATE of a historical row (even a no-op rewrite) changes the hash.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
create function pg_temp.fp(p_table regclass, p_exclude text[] default '{}') returns text
language plpgsql as $$
declare v_out text;
begin
  execute format($f$select count(*)||'|'||coalesce(md5(string_agg((to_jsonb(t) - %L::text[])::text, '~' order by (to_jsonb(t) - %L::text[])::text)),'-') from %s t$f$,
    p_exclude, p_exclude, p_table) into v_out;
  return p_table::text||'|'||v_out;
end $$;
select pg_temp.fp('public.organizations')
union all select pg_temp.fp('public.customers')
union all select pg_temp.fp('public.pets')
union all select pg_temp.fp('public.organization_pet_types')
union all select pg_temp.fp('public.organization_dog_size_boundaries')
union all select pg_temp.fp('public.service_catalog')
union all select pg_temp.fp('public.packages')
union all select pg_temp.fp('public.customer_packages','{size_band_snapshot,size_label_snapshot}')
union all select pg_temp.fp('public.customer_package_ledger')
union all select pg_temp.fp('public.bookings')
union all select pg_temp.fp('public.grooming_jobs')
union all select pg_temp.fp('public.grooming_job_pets')
union all select pg_temp.fp('public.grooming_job_pet_services','{pet_size_label_snapshot,pet_weight_kg_snapshot,size_layout_version_snapshot}')
union all select pg_temp.fp('public.invoices')
union all select pg_temp.fp('public.invoice_lines')
union all select pg_temp.fp('public.payments')
union all select pg_temp.fp('public.payroll_cycle_settings')
union all select pg_temp.fp('public.staff_payroll_settings')
union all select pg_temp.fp('public.payroll_runs')
union all select pg_temp.fp('public.payroll_items')
union all select 'pets.size distribution|'||coalesce(string_agg(s||'='||n, ',' order by s),'-') from (select coalesce(size,'<null>') s, count(*) n from public.pets group by 1) d
union all select 'snapshot distribution|'||coalesce(string_agg(s||'='||n, ',' order by s),'-') from (select coalesce(pet_size_snapshot,'<null>') s, count(*) n from public.grooming_job_pet_services group by 1) d
union all select 'package band distribution|'||coalesce(string_agg(s||'='||n, ',' order by s),'-') from (select coalesce(size_band,'<null>') s, count(*) n from public.packages group by 1) d
order by 1;
