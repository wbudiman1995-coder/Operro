\set ON_ERROR_STOP on
do $$
declare v_code text;
begin
  insert into public.customers (organization_id,display_name)
  values ('0c400000-0000-4000-8000-000000000003','D first')
  returning customer_code into v_code;
  if v_code <> 'CUST-001' then raise exception 'different-org expected CUST-001, got %', v_code; end if;
  raise notice 'PASS: different-org D received %', v_code;
end $$;
