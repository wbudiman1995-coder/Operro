\set ON_ERROR_STOP on
begin;
insert into public.customers (organization_id,display_name)
values ('0c400000-0000-4000-8000-000000000001','A first');
select pg_sleep(2);
commit;
