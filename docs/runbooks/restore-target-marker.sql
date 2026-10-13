-- Declares a database to be a DISPOSABLE restore target. Run it ONCE, by hand, against the throw-away database you will restore into,
-- before generating or running a restore script. It is the explicit act that makes the guarded restore script willing to run.
--
--   psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 -v org=<organization uuid from manifest.json> \
--        -v name='<the organization name from manifest.json>' -v slug='<its slug>' -f docs/runbooks/restore-target-marker.sql
--
-- Rules (read them; the script cannot enforce all of them):
--   * Never run this against production or against any database anyone relies on. No migration creates this table, so production never
--     has it; creating it there would remove the main protection. If you are unsure which database a connection string points at, stop.
--   * The database must already have every Operro migration applied (run the same migrations the project uses), so its schema matches.
--   * Creating the organization row must NOT seed the default configuration a normal sign-up creates (size bands and similar): the
--     restore requires the target to hold nothing for the organization except this row. Hence triggers are bypassed for the one insert.
--   * Users, roles and memberships are NOT restored (they are not in the archive). Rows that point at them keep their original ids,
--     which will not resolve in this database; the restore report lists those external references.
begin;
create table if not exists public.operro_restore_target (
  kind text primary key check (kind = 'disposable'),
  declared_at timestamptz not null default now()
);
insert into public.operro_restore_target (kind) values ('disposable') on conflict do nothing;

set local session_replication_role = replica;
insert into public.organizations (id, name, slug, status)
values (:'org'::uuid, :'name', :'slug', 'active')
on conflict (id) do nothing;
commit;

select 'marker present: ' || (select count(*) from public.operro_restore_target) || ', organization rows: ' || (select count(*) from public.organizations where id = :'org'::uuid);
