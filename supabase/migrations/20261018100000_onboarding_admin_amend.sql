-- Reviewers can correct a submitted registration before it becomes CRM data.
-- The single-use public link remains submitted; only a member with customer.manage
-- in that exact organization may amend the queued payload.
create or replace function app.amend_customer_onboarding(
  p_submission uuid, p_payload jsonb, p_expected_updated_at timestamptz
) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_row public.customer_onboarding_submissions;
  v_pet jsonb;
  v_updated timestamptz;
begin
  if v_org is null or not app.has_permission('customer.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.customer_onboarding_submissions
    where organization_id = v_org and id = p_submission and status = 'submitted' for update;
  if not found then raise exception 'submission_not_found' using errcode = 'P0002'; end if;
  if v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'submission_changed' using errcode = '40001';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
     or length(trim(coalesce(p_payload->>'customerName',''))) not between 2 and 120
     or length(trim(coalesce(p_payload->>'phone',''))) not between 7 and 40
     or length(trim(coalesce(p_payload->>'addressLine',''))) not between 1 and 200
     or length(trim(coalesce(p_payload->>'province',''))) < 2
     or length(trim(coalesce(p_payload->>'kabupatenKota',''))) < 2
     or length(trim(coalesce(p_payload->>'kecamatan',''))) < 2
     or length(coalesce(p_payload->>'googleMapsUrl','')) > 1000
     or jsonb_typeof(p_payload->'pets') is distinct from 'array'
     or jsonb_array_length(p_payload->'pets') not between 1 and 5
     or length(p_payload::text) > 32768 then
    raise exception 'invalid_submission' using errcode = '22023';
  end if;
  for v_pet in select value from jsonb_array_elements(p_payload->'pets') loop
    if length(trim(coalesce(v_pet->>'name',''))) not between 1 and 80
       or v_pet->>'species' not in ('dog','cat')
       or nullif(v_pet->>'weightKg','') is null
       or (v_pet->>'weightKg') !~ '^\d{1,3}(\.\d{1,3})?$'
       or (v_pet->>'weightKg')::numeric <= 0 then
      raise exception 'invalid_pet' using errcode = '22023';
    end if;
  end loop;
  update public.customer_onboarding_submissions set payload = p_payload
    where organization_id = v_org and id = p_submission returning updated_at into v_updated;
  return v_updated;
end $$;
revoke all on function app.amend_customer_onboarding(uuid,jsonb,timestamptz) from public;
grant execute on function app.amend_customer_onboarding(uuid,jsonb,timestamptz) to authenticated;
