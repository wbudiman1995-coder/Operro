-- Session B: void_line. ON_ERROR_STOP=1. Same expectation as setqty.
\set ON_ERROR_STOP on
do $$
declare v_line uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','0c100000-0000-4000-8000-0000000000c1','active_org_id','0c100000-0000-4000-8000-000000000001')::text, true);
  select gjps.id into v_line from public.grooming_job_pet_services gjps
    join public.grooming_job_pets gjp on gjp.id=gjps.grooming_job_pet_id
    where gjp.grooming_job_id='0c100000-0000-4000-8000-00000000ba01' limit 1;
  begin
    perform app.assembly_void_line(v_line, 'concurrency void');
    raise exception 'UNEXPECTED: void_line succeeded on a completing/completed booking';
  exception when check_violation then
    if sqlerrm like '%booking_not_open_for_assembly%' then
      raise notice 'PASS: B void_line received frozen-booking rejection (%).', sqlerrm;
    else
      raise exception 'UNEXPECTED check_violation: %', sqlerrm;
    end if;
  end;
end $$;
