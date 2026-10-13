-- Platform-owner control for the official WhatsApp setup gate.
--
-- This switch permits an organization owner to enable its already-configured provider
-- settings. It does not send a message, read a webhook, store a credential, or claim
-- delivery/read status. Credentials remain in the hosting secret store.
begin;

create or replace function app.whatsapp_provider_platform_gate()
returns table (enabled boolean, note text, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode = '42501'; end if;
  return query select f.enabled, f.note, f.updated_at
    from public.platform_flags f where f.key = 'whatsapp_provider_available';
end $$;

create or replace function app.set_whatsapp_provider_platform_gate(p_enabled boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_enabled is null then raise exception 'invalid_gate_value' using errcode = '22023'; end if;
  update public.platform_flags
     set enabled = p_enabled,
         note = case when p_enabled
           then 'Organization owners may activate their prepared official provider settings. Operro still does not send messages or process delivery webhooks.'
           else 'Official provider setup is closed by the platform owner. Manual WhatsApp drafts remain available.'
         end,
         updated_at = now()
   where key = 'whatsapp_provider_available';
  if not found then raise exception 'platform_gate_missing' using errcode = '23503'; end if;
  return p_enabled;
end $$;

revoke all on function app.whatsapp_provider_platform_gate() from public, anon, authenticated;
revoke all on function app.set_whatsapp_provider_platform_gate(boolean) from public, anon, authenticated;
grant execute on function app.whatsapp_provider_platform_gate() to authenticated;
grant execute on function app.set_whatsapp_provider_platform_gate(boolean) to authenticated;

create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101170000'::text;
$$;

notify pgrst, 'reload schema';
commit;
