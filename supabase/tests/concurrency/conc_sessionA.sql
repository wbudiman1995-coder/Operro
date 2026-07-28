\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims', json_build_object('sub','0c100000-0000-4000-8000-0000000000c1','active_org_id','0c100000-0000-4000-8000-000000000001')::text, true);
select 'A: locking booking via complete_booking' as step;
select app.complete_booking('0c100000-0000-4000-8000-00000000ba01', false, null);
select pg_sleep(3);
commit;
select 'A: committed' as step;
