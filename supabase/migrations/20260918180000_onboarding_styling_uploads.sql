-- Token-scoped private uploads for customer self-onboarding. The raw token is
-- never placed in object paths: the browser uses its SHA-256 hash. Approval
-- materializes attachment metadata and links each photo to the created pet.

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('onboarding-styling','onboarding-styling',false,1572864,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create function app.can_upload_onboarding_style(p_org text,p_hash text)
returns boolean language sql stable security definer set search_path=app,public as $$
  select exists(select 1 from public.customer_onboarding_links l where l.organization_id::text=p_org and l.token_hash=p_hash and l.status='active' and l.expires_at>now())
$$;
revoke all on function app.can_upload_onboarding_style(text,text) from public;
grant execute on function app.can_upload_onboarding_style(text,text) to anon,authenticated;

create policy onboarding_styling_anon_insert on storage.objects for insert to anon
with check (
  bucket_id='onboarding-styling'
  and app.can_upload_onboarding_style((storage.foldername(name))[1],(storage.foldername(name))[2])
);
create policy onboarding_styling_member_read on storage.objects for select to authenticated
using (bucket_id='onboarding-styling' and (storage.foldername(name))[1]=app.fn_active_organization()::text and app.has_membership());
create policy onboarding_styling_manager_delete on storage.objects for delete to authenticated
using (bucket_id='onboarding-styling' and (storage.foldername(name))[1]=app.fn_active_organization()::text and app.has_permission('customer.manage'));

drop function app.get_customer_onboarding_link(text);
create function app.get_customer_onboarding_link(p_token text)
returns table(valid boolean,status text,expires_at timestamptz,organization_name text,organization_id uuid)
language sql security definer set search_path=app,public,extensions as $$
  select (l.status='active' and l.expires_at>now()),
         case when l.expires_at<=now() and l.status='active' then 'expired' else l.status end,
         l.expires_at,o.name,l.organization_id
  from public.customer_onboarding_links l join public.organizations o on o.id=l.organization_id
  where l.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') limit 1
$$;

create or replace function app.review_customer_onboarding(p_submission uuid,p_decision text,p_merge_customer uuid default null)
returns uuid language plpgsql security definer set search_path=app,public as $$
declare
  v_org uuid:=app.fn_active_organization(); v_sub public.customer_onboarding_submissions;
  v_link public.customer_onboarding_links; v_customer uuid; v_pet jsonb; v_pet_id uuid;
  v_ref jsonb; v_payload jsonb; v_lat numeric; v_lng numeric; v_client_pet_id text;
  v_path text; v_mime text; v_size bigint; v_expires timestamptz:=now()+interval '180 days';
begin
  if v_org is null or not app.has_permission('customer.manage') then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_decision not in ('approve','reject') then raise exception 'invalid_decision' using errcode='22023'; end if;
  select * into v_sub from public.customer_onboarding_submissions where organization_id=v_org and id=p_submission and status='submitted' for update;
  if not found then raise exception 'submission_not_found' using errcode='P0002'; end if;
  select * into v_link from public.customer_onboarding_links where organization_id=v_org and id=v_sub.link_id for update;
  if p_decision='reject' then
    update public.customer_onboarding_submissions set status='rejected',reviewed_at=now(),reviewed_by=auth.uid() where id=v_sub.id;
    update public.customer_onboarding_links set status='rejected' where id=v_link.id; return null;
  end if;
  v_payload:=v_sub.payload;
  if p_merge_customer is not null then
    select id into v_customer from public.customers where organization_id=v_org and id=p_merge_customer and deleted_at is null;
    if not found then raise exception 'merge_customer_not_found' using errcode='P0002'; end if;
  else
    insert into public.customers(organization_id,display_name,phone,status,source,notes,metadata)
    values(v_org,left(trim(v_payload->>'customerName'),120),left(trim(v_payload->>'phone'),40),'active',coalesce(v_link.source,'Self onboarding'),left(v_payload->>'customerNotes',2000),jsonb_build_object('created_from','self_onboarding','onboarding_submission_id',v_sub.id)) returning id into v_customer;
  end if;
  for v_pet in select value from jsonb_array_elements(v_payload->'pets') loop
    v_client_pet_id:=left(coalesce(v_pet->>'clientId',''),80);
    insert into public.pets(organization_id,customer_id,name,species,breed,weight_kg,color,notes,status,metadata)
    values(v_org,v_customer,left(trim(v_pet->>'name'),80),case when v_pet->>'species'='cat' then 'cat' else 'dog' end,left(nullif(trim(v_pet->>'breed'),''),100),nullif(v_pet->>'weightKg','')::numeric,left(nullif(trim(v_pet->>'color'),''),80),left(nullif(trim(v_pet->>'notes'),''),1000),'active',jsonb_build_object('created_from','self_onboarding','stated_age',coalesce(v_pet->>'age',''),'onboarding_submission_id',v_sub.id,'client_pet_id',v_client_pet_id)) returning id into v_pet_id;
    if jsonb_typeof(v_pet->'styleReferences')='array' and jsonb_array_length(v_pet->'styleReferences')<=2 then
      for v_ref in select value from jsonb_array_elements(v_pet->'styleReferences') loop
        v_path:=coalesce(v_ref->>'path',''); v_mime:=coalesce(v_ref->>'mimeType','');
        begin v_size:=(v_ref->>'sizeBytes')::bigint; exception when others then v_size:=0; end;
        if v_client_pet_id<>''
           and v_path like v_org::text||'/'||v_link.token_hash||'/'||v_client_pet_id||'/%'
           and v_mime in ('image/jpeg','image/png','image/webp') and v_size between 1 and 1572864
           and exists(select 1 from storage.objects where bucket_id='onboarding-styling' and name=v_path) then
          with inserted as (
            insert into public.attachments(organization_id,storage_bucket,storage_path,filename,mime_type,size_bytes,metadata)
            values(v_org,'onboarding-styling',v_path,left(coalesce(nullif(v_ref->>'filename',''),'referensi'),200),v_mime,v_size,jsonb_build_object('kind','styling_reference','customer_id',v_customer,'pet_id',v_pet_id,'caption',left(coalesce(v_ref->>'caption',''),300),'expires_at',v_expires,'onboarding_submission_id',v_sub.id))
            returning id
          )
          insert into public.attachment_links(organization_id,attachment_id,subject_type,subject_id)
          select v_org,id,'pet',v_pet_id from inserted;
        end if;
      end loop;
    end if;
  end loop;
  if p_merge_customer is null and length(trim(coalesce(v_payload->>'addressLine','')))>0 then
    begin v_lat:=nullif(v_payload->>'latitude','')::numeric; v_lng:=nullif(v_payload->>'longitude','')::numeric; exception when others then v_lat:=null;v_lng:=null; end;
    insert into public.customer_addresses(organization_id,customer_id,label,recipient_name,recipient_phone,line1,kecamatan,kabupaten_kota,latitude,longitude,is_default)
    values(v_org,v_customer,'Rumah',left(v_payload->>'customerName',120),left(v_payload->>'phone',40),left(v_payload->>'addressLine',200),left(nullif(v_payload->>'kecamatan',''),100),left(nullif(v_payload->>'kabupatenKota',''),100),case when abs(v_lat)<=90 then v_lat end,case when abs(v_lng)<=180 then v_lng end,true);
  end if;
  update public.customer_onboarding_submissions set status='approved',reviewed_at=now(),reviewed_by=auth.uid(),merged_customer_id=v_customer where id=v_sub.id;
  update public.customer_onboarding_links set status='approved' where id=v_link.id;
  return v_customer;
end $$;

revoke all on function app.get_customer_onboarding_link(text) from public;
grant execute on function app.get_customer_onboarding_link(text) to anon,authenticated;
notify pgrst,'reload schema';
