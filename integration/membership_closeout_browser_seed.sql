-- Disposable LOCAL Supabase only, after the existing HomePaw seeds.
-- Never run against production. Uses synthetic QA data and the local seed password.
\set ON_ERROR_STOP on
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,is_super_admin,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
values ('00000000-0000-0000-0000-000000000000','e1c00000-0000-4000-8000-000000000001','authenticated','authenticated','membership-reader@homepaw.local',extensions.crypt('operro-local-qa',extensions.gen_salt('bf')),now(),'{"provider":"email","providers":["email"]}','{"full_name":"Membership QA Reader"}',false,now(),now(),'','','','')
on conflict(id) do nothing;
insert into auth.identities(id,user_id,provider_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
values ('e1c00000-0000-4000-8000-000000000002','e1c00000-0000-4000-8000-000000000001','e1c00000-0000-4000-8000-000000000001','{"sub":"e1c00000-0000-4000-8000-000000000001","email":"membership-reader@homepaw.local"}','email',now(),now(),now()) on conflict do nothing;
insert into public.roles(id,organization_id,name,is_system) values('e1c00000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000001','Membership QA Reader',false) on conflict do nothing;
insert into public.memberships(id,organization_id,user_id,role_id,status) values('e1c00000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-000000000001','e1c00000-0000-4000-8000-000000000001','e1c00000-0000-4000-8000-000000000003','active') on conflict do nothing;
insert into public.role_permissions(organization_id,role_id,permission_id)
select 'd0000000-0000-4000-8000-000000000001','e1c00000-0000-4000-8000-000000000003',id from public.permissions
where key in ('membership.read','customer.read','catalog.read','invoice.read','booking.read') on conflict do nothing;
insert into public.membership_branch_access(organization_id,membership_id,branch_id)
values('d0000000-0000-4000-8000-000000000001','e1c00000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-000000000010') on conflict do nothing;

select set_config('request.jwt.claims','{"sub":"e0000000-0000-4000-8000-000000000001","active_org_id":"d0000000-0000-4000-8000-000000000001"}',true);
do $$ declare invoice public.invoices; cp uuid; spec record;
begin
  for spec in select * from (values
    ('e1c00001-0000-4000-8000-000000000001'::uuid,'QA H Held scope','d0000000-0000-4000-8000-000000000302'::uuid,'d0000000-0000-4000-8000-000000000402'::uuid,'d0000000-0000-4000-8000-000000000101'::uuid),
    ('e1c00002-0000-4000-8000-000000000001'::uuid,'QA R Renewed scope','d0000000-0000-4000-8000-000000000303'::uuid,'d0000000-0000-4000-8000-000000000403'::uuid,'d0000000-0000-4000-8000-000000000103'::uuid),
    ('e1c00003-0000-4000-8000-000000000001'::uuid,'QA U Editable scope','d0000000-0000-4000-8000-000000000304'::uuid,'d0000000-0000-4000-8000-000000000404'::uuid,'d0000000-0000-4000-8000-000000000102'::uuid)
  ) as fixtures(id,name,customer,pet,service) loop
    insert into public.packages(id,organization_id,name,service_id,total_sessions,price,currency,validity_days,is_active,per_pet)
    values(spec.id,'d0000000-0000-4000-8000-000000000001',spec.name,spec.service,5,250000,'IDR',90,true,true) on conflict do nothing;
    if not exists(select 1 from public.customer_packages where package_id=spec.id) then
      invoice := app.create_package_invoice('d0000000-0000-4000-8000-000000000010',spec.customer,spec.id,now(),null,'Local closeout QA',spec.id,spec.pet);
      select id into cp from public.customer_packages where source_invoice_id=invoice.id;
      if spec.name='QA H Held scope' then
        perform app.reserve_package_session('d0000000-0000-4000-8000-000000000702',cp);
      elsif spec.name='QA R Renewed scope' then
        perform app.renew_customer_package(cp,'d0000000-0000-4000-8000-000000000010',now(),null,'Local closeout QA renewal','e1c00004-0000-4000-8000-000000000001',app.preview_package_renewal(cp)->>'terms_fingerprint');
      end if;
    end if;
  end loop;
end $$;
commit;
