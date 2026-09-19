-- Organization-specific onboarding copy and styling-reference retention.
create table public.customer_onboarding_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  whatsapp_template text not null default E'Halo kak! Isi data kamu dan anabul untuk {business} melalui link ini:\n\n{link}\n\nLink berlaku dua hari.',
  reference_retention_days integer not null default 180 check (reference_retention_days between 30 and 365),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create trigger trg_customer_onboarding_settings_updated before update on public.customer_onboarding_settings for each row execute function app.tg_set_updated_at();
create trigger trg_customer_onboarding_settings_audit_cols before insert or update on public.customer_onboarding_settings for each row execute function app.tg_set_audit_columns();
create trigger trg_customer_onboarding_settings_audit after insert or update or delete on public.customer_onboarding_settings for each row execute function app.tg_write_audit();
alter table public.customer_onboarding_settings enable row level security;
grant select,insert,update on public.customer_onboarding_settings to authenticated;
create policy customer_onboarding_settings_org on public.customer_onboarding_settings for all
using (organization_id=app.fn_active_organization()) with check (organization_id=app.fn_active_organization());
create policy customer_onboarding_settings_manage on public.customer_onboarding_settings as restrictive for all
using (app.has_permission('customer.manage')) with check (app.has_permission('customer.manage'));

-- Approval creates attachment metadata through the existing RPC. This trigger
-- replaces its fallback 180-day expiry with the active organization's setting.
create function app.tg_apply_onboarding_reference_retention()
returns trigger language plpgsql security definer set search_path=app,public as $$
declare v_days integer;
begin
  if new.storage_bucket='onboarding-styling' and new.metadata->>'kind'='styling_reference' then
    select reference_retention_days into v_days from public.customer_onboarding_settings where organization_id=new.organization_id;
    v_days:=coalesce(v_days,180);
    new.metadata:=jsonb_set(new.metadata,'{expires_at}',to_jsonb(now()+make_interval(days=>v_days)),true);
  end if;
  return new;
end $$;
create trigger trg_attachments_onboarding_retention before insert on public.attachments
for each row execute function app.tg_apply_onboarding_reference_retention();
