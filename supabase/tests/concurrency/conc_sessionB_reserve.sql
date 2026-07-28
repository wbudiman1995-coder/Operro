-- Session B: reserve_package_session. ON_ERROR_STOP=1. Reservation must not race
-- with completion: B blocks on A's booking lock, then gets frozen-booking reject.
\set ON_ERROR_STOP on
do $$
declare v_line uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','0c100000-0000-4000-8000-0000000000c1','active_org_id','0c100000-0000-4000-8000-000000000001')::text, true);
  select gjps.id into v_line from public.grooming_job_pet_services gjps
    join public.grooming_job_pets gjp on gjp.id=gjps.grooming_job_pet_id
    where gjp.grooming_job_id='0c100000-0000-4000-8000-00000000ba01' limit 1;
  begin
    perform app.reserve_package_session(v_line, '0c100000-0000-4000-8000-00000000ca01');
    raise exception 'UNEXPECTED: reserve_package_session succeeded on a completing/completed booking';
  exception when check_violation then
    if sqlerrm like '%booking_not_open_for_assembly%' then
      raise notice 'PASS: B reserve_package_session received frozen-booking rejection (%).', sqlerrm;
    else
      raise exception 'UNEXPECTED check_violation: %', sqlerrm;
    end if;
  end;
end $$;
