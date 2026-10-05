-- Existing audit RPC access contract used by the invoice history panel.
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.ok(cond boolean, label text)
returns void language plpgsql as $$
begin if cond then raise notice 'PASS: %', label; else raise exception 'FAIL: %', label; end if; end $$;

insert into public.organizations(id,name,slug,status) values
  ('0f420000-0000-4000-8000-000000000001','Audit Org A','audit-org-a','active'),
  ('0f420000-0000-4000-8000-000000000002','Audit Org B','audit-org-b','active');
insert into public.subscriptions(organization_id,status,current_period_start,current_period_end) values
  ('0f420000-0000-4000-8000-000000000001','active',now()-interval '1 day',now()+interval '1 year'),
  ('0f420000-0000-4000-8000-000000000002','active',now()-interval '1 day',now()+interval '1 year');
insert into public.roles(id,organization_id,name,is_system) values
  ('0f420000-0000-4000-8000-000000000011','0f420000-0000-4000-8000-000000000001','Auditor',true),
  ('0f420000-0000-4000-8000-000000000012','0f420000-0000-4000-8000-000000000002','Auditor',true);
insert into auth.users(id,email,raw_user_meta_data) values
  ('0f420000-0000-4000-8000-000000000021','audit-a@example.test','{}'),
  ('0f420000-0000-4000-8000-000000000022','audit-b@example.test','{}');
update public.users set status='active' where id in
  ('0f420000-0000-4000-8000-000000000021','0f420000-0000-4000-8000-000000000022');
insert into public.memberships(user_id,organization_id,role_id,status) values
  ('0f420000-0000-4000-8000-000000000021','0f420000-0000-4000-8000-000000000001','0f420000-0000-4000-8000-000000000011','active'),
  ('0f420000-0000-4000-8000-000000000022','0f420000-0000-4000-8000-000000000002','0f420000-0000-4000-8000-000000000012','active');

insert into app.audit_log(id,organization_id,actor_id,action,entity_table,entity_id,diff,occurred_at) values
  ('0f420000-0000-4000-8000-000000000031','0f420000-0000-4000-8000-000000000001','0f420000-0000-4000-8000-000000000021','UPDATE','invoices','0f420000-0000-4000-8000-000000000041','{"old":{"status":"draft"},"new":{"status":"issued"}}',now()),
  ('0f420000-0000-4000-8000-000000000032','0f420000-0000-4000-8000-000000000002','0f420000-0000-4000-8000-000000000022','UPDATE','invoices','0f420000-0000-4000-8000-000000000042','{"old":{"status":"draft"},"new":{"status":"issued"}}',now());

set local role authenticated;

do $$
declare v_count integer; v_diff jsonb;
begin
  perform set_config('request.jwt.claims','{"sub":"0f420000-0000-4000-8000-000000000021","active_org_id":"0f420000-0000-4000-8000-000000000001","role":"authenticated"}',true);
  select count(*) into v_count
    from app.list_audit_events('invoices','0f420000-0000-4000-8000-000000000041',20);
  select diff into v_diff
    from app.list_audit_events('invoices','0f420000-0000-4000-8000-000000000041',20)
    limit 1;
  perform pg_temp.ok(v_count=1 and v_diff->'new'->>'status'='issued','org A reads its invoice audit event');
  select count(*) into v_count
    from app.list_audit_events('invoices','0f420000-0000-4000-8000-000000000042',20);
  perform pg_temp.ok(v_count=0,'org A cannot read org B invoice audit event');
  select count(*) into v_count
    from app.list_audit_events('customers','0f420000-0000-4000-8000-000000000041',20);
  perform pg_temp.ok(v_count=0,'entity-table filter is enforced');

  perform set_config('request.jwt.claims','{"sub":"0f420000-0000-4000-8000-000000000022","active_org_id":"0f420000-0000-4000-8000-000000000002","role":"authenticated"}',true);
  select count(*) into v_count
    from app.list_audit_events('invoices','0f420000-0000-4000-8000-000000000042',20);
  perform pg_temp.ok(v_count=1,'org B reads its own invoice audit event');
end $$;

rollback;
