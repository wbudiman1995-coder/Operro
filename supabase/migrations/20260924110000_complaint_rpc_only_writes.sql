-- Supabase's public-schema default grants include table writes for authenticated.
-- Keep complaint mutations behind the validated SECURITY DEFINER RPCs.
begin;

revoke insert,update,delete on public.complaints from anon,authenticated;
grant select on public.complaints to authenticated;

notify pgrst,'reload schema';
commit;
