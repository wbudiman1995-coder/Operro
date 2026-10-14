-- A pending invitation is a bearer capability. It may reveal its recipient email
-- to the person holding that capability, but it must reveal nothing else and may
-- not create a membership. Membership creation remains guarded by claim_access_invitation.
create or replace function app.pending_access_invitation_email(p_token text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_invitation' using errcode = '22023';
  end if;

  select email into v_email
  from public.platform_access_invitations
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and status = 'pending'
    and expires_at > now();

  if v_email is null then
    raise exception 'invitation_unavailable' using errcode = '22023';
  end if;

  return v_email;
end;
$$;

revoke all on function app.pending_access_invitation_email(text) from public;
grant execute on function app.pending_access_invitation_email(text) to anon, authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts.
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101210000'::text;
$$;
