-- Keep a submitted Google Maps share link on the saved address. Short links
-- cannot always be resolved to coordinates without an HTTP request.
alter table public.customer_addresses add column google_maps_url text
  check (google_maps_url is null or length(google_maps_url) <= 1000);

create or replace function app.tg_copy_onboarding_maps_link()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_url text;
begin
  if new.status <> 'approved' or old.status = 'approved' then return new; end if;
  v_url := nullif(trim(new.payload->>'googleMapsUrl'), '');
  if v_url is null or length(v_url) > 1000 or v_url !~* '^https://((www|maps)\.google\.(com|co\.id)|google\.(com|co\.id)|maps\.app\.goo\.gl|share\.google|g\.co|goo\.gl)(/|[?#]|$)' then return new; end if;
  update public.customer_addresses a set google_maps_url = v_url
  from public.customers c
  where a.organization_id = new.organization_id and a.customer_id = new.merged_customer_id
    and a.is_default and a.deleted_at is null
    and c.id = a.customer_id and c.organization_id = new.organization_id
    and c.metadata->>'onboarding_submission_id' = new.id::text;
  return new;
end $$;
create trigger trg_copy_onboarding_maps_link after update of status on public.customer_onboarding_submissions
  for each row execute function app.tg_copy_onboarding_maps_link();
