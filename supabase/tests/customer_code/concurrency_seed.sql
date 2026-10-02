\set ON_ERROR_STOP on
insert into public.organizations (id,name,slug,status) values
  ('0c400000-0000-4000-8000-000000000001','Code Concurrency 1','code-concurrency-1','active'),
  ('0c400000-0000-4000-8000-000000000002','Code Concurrency 2','code-concurrency-2','active'),
  ('0c400000-0000-4000-8000-000000000003','Code Concurrency 3','code-concurrency-3','active')
on conflict (id) do update set status=excluded.status;
delete from public.customers where organization_id in (
  '0c400000-0000-4000-8000-000000000001',
  '0c400000-0000-4000-8000-000000000002',
  '0c400000-0000-4000-8000-000000000003'
);
