-- Archives the isolated demo workspace without deleting immutable audit ledgers.
-- Run as a privileged database operator. The original HomePaw workspace is untouched.
do $$
declare v_org uuid := 'd0000000-0000-4000-8000-000000000001';
begin
  update public.memberships set status='removed',deleted_at=coalesce(deleted_at,now()) where organization_id=v_org;
  update public.organizations set status='deleted',deleted_at=coalesce(deleted_at,now()) where id=v_org;
  raise notice 'HomePaw Demo archived. Immutable ledgers remain retained for audit integrity.';
end $$;
