-- Session B: set_line_quantity. ON_ERROR_STOP=1. B blocks on A's booking lock,
-- then (A having completed the booking) must receive booking_not_open_for_assembly.
\set ON_ERROR_STOP on
do $$
declare v_line uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','0c100000-0000-4000-8000-0000000000c1','active_org_id','0c100000-0000-4000-8000-000000000001')::text, true);
  select gjps.id into v_line from public.grooming_job_pet_services gjps
    join public.grooming_job_pets gjp on gjp.id=gjps.grooming_job_pet_id
    where gjp.grooming_job_id='0c100000-0000-4000-8000-00000000ba01' limit 1;
  begin
    perform app.assembly_set_line_quantity(v_line, 2);
    raise exception 'UNEXPECTED: set_line_quantity succeeded on a completing/completed booking';
  exception when check_violation then
    if sqlerrm like '%booking_not_open_for_assembly%' then
      raise notice 'PASS: B set_line_quantity received frozen-booking rejection (%).', sqlerrm;
    else
      raise exception 'UNEXPECTED check_violation: %', sqlerrm;
    end if;
  end;
end $$;
