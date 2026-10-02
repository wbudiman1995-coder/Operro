\set ON_ERROR_STOP on
begin;

do $$
declare
  v_org_a uuid;
  v_org_b uuid;
  v_org_boundary uuid;
  v_code text;
  v_failed boolean;
begin
  insert into public.organizations (name, slug)
    values ('Customer Code A', 'customer-code-a-' || gen_random_uuid())
    returning id into v_org_a;
  insert into public.organizations (name, slug)
    values ('Customer Code B', 'customer-code-b-' || gen_random_uuid())
    returning id into v_org_b;
  insert into public.organizations (name, slug)
    values ('Customer Code Boundary', 'customer-code-boundary-' || gen_random_uuid())
    returning id into v_org_boundary;

  insert into public.customers (organization_id, display_name)
    values (v_org_a, 'A1') returning customer_code into v_code;
  if v_code <> 'CUST-001' then raise exception 'A1 expected CUST-001, got %', v_code; end if;

  insert into public.customers (organization_id, display_name)
    values (v_org_a, 'A2') returning customer_code into v_code;
  if v_code <> 'CUST-002' then raise exception 'A2 expected CUST-002, got %', v_code; end if;

  insert into public.customers (organization_id, display_name)
    values (v_org_b, 'B1') returning customer_code into v_code;
  if v_code <> 'CUST-001' then raise exception 'B1 expected CUST-001, got %', v_code; end if;

  v_failed := false;
  begin
    insert into public.customers (organization_id, display_name, customer_code)
      values (v_org_a, 'Explicit', 'CUST-500');
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then raise exception 'caller-supplied customer_code was accepted'; end if;

  insert into public.customers (organization_id, display_name, customer_code)
    values (v_org_a, 'Blank', '   ') returning customer_code into v_code;
  if v_code <> 'CUST-003' then raise exception 'blank expected CUST-003, got %', v_code; end if;

  v_failed := false;
  begin
    update public.customers
       set customer_code = 'CUST-999'
     where organization_id = v_org_a and customer_code = 'CUST-001';
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then raise exception 'customer_code update was accepted'; end if;

  -- Seed the boundary without invoking the allocator, then prove the real
  -- allocator preserves all four digits for the next row.
  alter table public.customers disable trigger trg_customers_assign_code;
  insert into public.customers (organization_id, display_name, customer_code)
    values (v_org_boundary, 'Boundary 999', 'CUST-999');
  alter table public.customers enable trigger trg_customers_assign_code;

  insert into public.customers (organization_id, display_name)
    values (v_org_boundary, 'Boundary 1000') returning customer_code into v_code;
  if v_code <> 'CUST-1000' then raise exception 'boundary expected CUST-1000, got %', v_code; end if;

  raise notice 'CUSTOMER CODE CONTRACT PASS';
end $$;

rollback;
