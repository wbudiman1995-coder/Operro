-- Finishes the business-owner access flow without broadening platform powers.
-- A business owner can add only an Admin in their own active organization;
-- platform-only roles stay with the Operro owner and groomers stay code-only.
begin;

create or replace function app.issue_access_invitation(p_org uuid,p_email text,p_role text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text; v_email text := lower(btrim(p_email));
begin
  if p_role not in ('Pemilik','Admin','Bantuan Operro','Groomer')
    or not exists(select 1 from public.roles where organization_id=p_org and name=p_role and deleted_at is null)
    or not exists(select 1 from public.organizations where id=p_org and status in ('trial','active') and deleted_at is null)
  then raise exception 'invalid_invitation' using errcode='22023'; end if;

  if not app.is_operro_owner() and not (p_role = 'Admin' and app.is_business_owner(p_org)) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  if v_email !~ '^[^@ ]+@[^@ ]+\.[^@ ]+$' or length(v_email)>254 then
    raise exception 'invalid_email' using errcode='22023'; end if;

  update public.platform_access_invitations set status='revoked'
    where organization_id=p_org and email=v_email and status='pending';
  v_token := replace(pg_catalog.gen_random_uuid()::text,'-','') || replace(pg_catalog.gen_random_uuid()::text,'-','');
  insert into public.platform_access_invitations(organization_id,email,role_name,token_hash,expires_at,created_by)
  values(p_org,v_email,p_role,encode(extensions.digest(v_token,'sha256'),'hex'),now()+interval '7 days',auth.uid());
  return v_token;
end;
$$;
revoke all on function app.issue_access_invitation(uuid,text,text) from public;
grant execute on function app.issue_access_invitation(uuid,text,text) to authenticated;

-- Existing organizations created before the band table must always have a
-- complete live band layout. This prevents customer/pet creation from failing
-- merely because a legacy tenant missed a historical seed trigger.
insert into public.organization_size_band_settings(organization_id, mode, layout_version)
select o.id, 'legacy', 1 from public.organizations o
where o.deleted_at is null
on conflict (organization_id) do nothing;

insert into public.organization_size_bands(organization_id, band_key, band_kind, label, sort_order, upper_kg, upper_inclusive)
select o.id, v.band_key, case when v.band_key = 'cat' then 'cat' else 'dog_weight' end, v.label, v.sort_order, v.upper_kg, v.upper_inclusive
from public.organizations o
cross join (values
  ('extra_small','XS',1,5::numeric,false),
  ('small','S',2,10::numeric,false),
  ('medium','M',3,15::numeric,false),
  ('large','L',4,25::numeric,true),
  ('extra_large','XL',5,null::numeric,false),
  ('cat','Cat',6,null::numeric,false)
) as v(band_key,label,sort_order,upper_kg,upper_inclusive)
where o.deleted_at is null
on conflict (organization_id, band_key) do nothing;

insert into public.organization_pet_types(organization_id,key,label,is_active)
select o.id, v.key, v.label, true from public.organizations o
cross join (values ('dog','Anjing'),('cat','Kucing')) as v(key,label)
where o.deleted_at is null
on conflict (organization_id,key) do nothing;

create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101200000'::text;
$$;

commit;
