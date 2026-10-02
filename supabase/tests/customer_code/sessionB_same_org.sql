\set ON_ERROR_STOP on
do $$
declare v_code text;
begin
  insert into public.customers (organization_id,display_name)
  values ('0c400000-0000-4000-8000-000000000001','B second')
  returning customer_code into v_code;
  if v_code <> 'CUST-002' then raise exception 'same-org expected CUST-002, got %', v_code; end if;
  raise notice 'PASS: same-org B received %', v_code;
end $$;
