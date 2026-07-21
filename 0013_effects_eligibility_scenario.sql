-- Session B (T11 concurrency): also runs as AUTHENTICATED. Starts ~1s after A,
-- blocks on the same customer_packages row lock A holds, and once A commits
-- (0 sessions now available) must be rejected with 'no_sessions_available'.
-- FINAL PASS ITEM 5: ON_ERROR_STOP is ON so the expected business error makes
-- psql exit NONZERO — session B must be a genuinely failing process, not a
-- successful psql whose output merely contains an error. The harness checks
-- B_RC explicitly and asserts exactly one expected ERROR line.
\set ON_ERROR_STOP on
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','0c000000-0000-4000-8000-000000000c01','active_org_id','0c000000-0000-4000-8000-000000000001')::text, true);
select 'B: attempting lineB as authenticated (expect rejection)' as step;
select app.reserve_package_session('0c000000-0000-4000-8000-0000000f1002','0c000000-0000-4000-8000-0000000ca001');
commit;
