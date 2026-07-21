-- Session A (T11 concurrency): runs as the AUTHENTICATED role (not superuser),
-- exercising the real client privilege path. Takes the single package session,
-- holds the row lock ~3s, then commits. Expected: succeeds with 1 reservation.
\set ON_ERROR_STOP on
begin;
-- Assume the least-privileged client role for the duration of the tx, exactly
-- as PostgREST/Supabase would after authenticating the JWT. SET LOCAL so it
-- reverts automatically at COMMIT/ROLLBACK.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','0c000000-0000-4000-8000-000000000c01','active_org_id','0c000000-0000-4000-8000-000000000001')::text, true);
select 'A: reserving lineA (as authenticated)' as step;
select app.reserve_package_session('0c000000-0000-4000-8000-0000000f1001','0c000000-0000-4000-8000-0000000ca001');
select pg_sleep(3);
commit;
select 'A: committed' as step;
