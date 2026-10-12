-- P6 invitation claim and multi-organization readiness at the database level (real roles, RLS, SECURITY DEFINER paths).
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261031145000_test_invitation_claim.sql
-- Complements 20261029155000 (suspended workspace, platform-owner switching, Admin checklist, helper-role denial) with the
-- invitation lifecycle: issue authority, hash-only storage, claim rules, expiry, revoke-by-reissue, suspended workspace,
-- already-a-member, unverified/foreign e-mail, deactivated user, malformed tokens, multi-organization membership.
-- Synthetic users in a rolled-back transaction: no real invitation, account or e-mail is created or sent.
\set ON_ERROR_STOP on
create or replace function pg_temp.claims(p_user uuid, p_org uuid, p_platform boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'active_org_id', p_org,
    'app_metadata', json_build_object('is_platform_admin', p_platform))::text, true);
end $$;
create or replace function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAIL: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded)', p_label;
end $$;
create or replace function pg_temp.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin if p_cond is true then raise notice 'PASS: %', p_label; else raise exception 'FAIL: %', p_label; end if; end $$;
create or replace function pg_temp.u(n integer) returns uuid language sql immutable as $$ select ('e6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

begin;
create or replace function pg_temp.member(p_user uuid, p_org uuid) returns text language sql security definer as $$
  select m.status || ':' || r.name from public.memberships m join public.roles r on r.id = m.role_id where m.user_id = p_user and m.organization_id = p_org $$;
create or replace function pg_temp.member_count(p_user uuid) returns integer language sql security definer as $$ select count(*)::integer from public.memberships where user_id = p_user and status = 'active' $$;
create or replace function pg_temp.active_org(p_user uuid) returns uuid language sql security definer as $$ select active_organization_id from public.users where id = p_user $$;
create or replace function pg_temp.invites(p_status text) returns integer language sql security definer as $$ select count(*)::integer from public.platform_access_invitations where status = p_status $$;
create temp table tok (k text primary key, v text);
grant all on tok to authenticated, anon;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (pg_temp.u(1), 'wbudiman1995@gmail.com', '{}', now()),   -- platform owner
  (pg_temp.u(2), 'owner-a@e6.test', '{}', now()),
  (pg_temp.u(3), 'admin-a@e6.test', '{}', now()),
  (pg_temp.u(4), 'invitee1@e6.test', '{}', now()),
  (pg_temp.u(5), 'invitee2@e6.test', '{}', now()),
  (pg_temp.u(6), 'unverified@e6.test', '{}', null),
  (pg_temp.u(7), 'stranger@e6.test', '{}', now()),
  (pg_temp.u(8), 'mixed@case.test', '{}', now()),
  (pg_temp.u(9), 'member-b@e6.test', '{}', now()),
  (pg_temp.u(10), 'gone@e6.test', '{}', now()),
  (pg_temp.u(11), 'groomer@e6.test', '{}', now()),
  (pg_temp.u(12), 'suspended-member@e6.test', '{}', now()),
  (pg_temp.u(13), 'owner-b@e6.test', '{}', now());
update public.users set status = 'active' where id::text like 'e6000000-%';
update public.users set status = 'deactivated' where id = pg_temp.u(10);
update public.users set is_platform_admin = true where id = pg_temp.u(1);

select pg_temp.claims(pg_temp.u(1), null, true);
do $$
declare a uuid; b uuid; s uuid;
begin
  a := app.prepare_operro_organization('E6 Alpha', 'e6-alpha');
  b := app.prepare_operro_organization('E6 Beta', 'e6-beta');
  s := app.prepare_operro_organization('E6 Suspend', 'e6-suspend');
  update public.organizations set status = 'active' where id in (a, b, s);
  perform set_config('e6.a', a::text, true); perform set_config('e6.b', b::text, true); perform set_config('e6.s', s::text, true);
  insert into public.memberships (user_id, organization_id, role_id, status)
  select o.uid, o.org, r.id, o.st from (values
    (pg_temp.u(2), a, 'Pemilik', 'active'), (pg_temp.u(3), a, 'Admin', 'active'), (pg_temp.u(9), b, 'Groomer', 'active'),
    (pg_temp.u(12), a, 'Admin', 'suspended'), (pg_temp.u(13), b, 'Pemilik', 'active')) as o(uid, org, rname, st)
  join public.roles r on r.organization_id = o.org and r.name = o.rname;
end $$;

-- ===== Issuing =============================================================================================================
do $$
declare a uuid := current_setting('e6.a')::uuid; t text;
begin
  t := app.issue_access_invitation(a, 'Invitee1@E6.test ', 'Admin');
  insert into tok values ('invitee1', t);
  perform pg_temp.ok(t ~ '^[0-9a-f]{64}$', 'the platform owner receives a 64-hex token');
  perform pg_temp.ok((select token_hash from public.platform_access_invitations where organization_id = a and email = 'invitee1@e6.test') = encode(extensions.digest(t, 'sha256'), 'hex'), 'only the sha-256 hash is stored, under a lower-cased trimmed e-mail');
  perform pg_temp.ok(not exists (select 1 from public.platform_access_invitations i where i::text like '%' || t || '%'), 'the plain token appears nowhere in the stored row');
  perform pg_temp.ok((select expires_at - created_at from public.platform_access_invitations where organization_id = a and email = 'invitee1@e6.test') = interval '7 days', 'an invitation lives seven days');
  perform pg_temp.expect(format('select app.issue_access_invitation(%L, %L, %L)', a, 'x@e6.test', 'Owner'), '22023', 'an unknown role name is refused');
  perform pg_temp.expect(format('select app.issue_access_invitation(%L, %L, %L)', a, 'x@e6.test', 'platform_admin'), '22023', 'no platform role can be invited');
  perform pg_temp.expect(format('select app.issue_access_invitation(%L, %L, %L)', a, 'not-an-email', 'Admin'), '22023', 'a malformed e-mail is refused');
  perform pg_temp.expect(format('select app.issue_access_invitation(%L, %L, %L)', a, repeat('a', 250) || '@e6.test', 'Admin'), '22023', 'an overlong e-mail is refused');
  perform pg_temp.expect(format('select app.issue_access_invitation(%L, %L, %L)', gen_random_uuid(), 'x@e6.test', 'Admin'), '22023', 'an unknown organization is refused');
end $$;
select pg_temp.claims(pg_temp.u(2), current_setting('e6.a')::uuid);
set local role authenticated;
do $$ begin
  perform pg_temp.expect(format('select app.issue_access_invitation(%L, %L, %L)', current_setting('e6.a'), 'x@e6.test', 'Admin'), '42501', 'a business owner cannot issue invitations (only Operro can)');
  perform pg_temp.ok(jsonb_array_length(app.list_access_invitations(current_setting('e6.a')::uuid)) = 1, 'the owner sees its pending invitation');
  perform pg_temp.ok(not (app.list_access_invitations(current_setting('e6.a')::uuid)::text ~* '(token|hash|[0-9a-f]{64})'), 'the listing never shows a token or hash');
  perform pg_temp.expect(format('select app.list_access_invitations(%L)', current_setting('e6.b')), '42501', 'nor another business''s invitations');
end $$;
select pg_temp.claims(pg_temp.u(3), current_setting('e6.a')::uuid);
do $$ begin
  perform pg_temp.expect(format('select app.list_access_invitations(%L)', current_setting('e6.a')), '42501', 'a tenant Admin cannot list invitations');
  perform pg_temp.expect(format('select app.issue_access_invitation(%L, %L, %L)', current_setting('e6.a'), 'x@e6.test', 'Pemilik'), '42501', 'a tenant Admin cannot issue an owner invitation');
end $$;
reset role;
set local role anon;
do $$ begin
  perform pg_temp.expect(format('select app.issue_access_invitation(%L, %L, %L)', current_setting('e6.a'), 'x@e6.test', 'Admin'), '42501', 'anon cannot issue');
  perform pg_temp.expect($q$select app.claim_access_invitation('00000000000000000000000000000000000000000000000000000000000000aa')$q$, '42501', 'anon cannot claim');
end $$;
reset role;

-- ===== Claiming =============================================================================================================
select pg_temp.claims(pg_temp.u(1), null, true);
do $$
declare a uuid := current_setting('e6.a')::uuid; b uuid := current_setting('e6.b')::uuid; s uuid := current_setting('e6.s')::uuid;
begin
  insert into tok values
    ('wrong', app.issue_access_invitation(a, 'invitee2@e6.test', 'Admin')),
    ('unver', app.issue_access_invitation(a, 'unverified@e6.test', 'Admin')),
    ('mixed', app.issue_access_invitation(a, 'MIXED@case.test', 'Bantuan Operro')),
    ('multi', app.issue_access_invitation(a, 'member-b@e6.test', 'Groomer')),
    ('gone', app.issue_access_invitation(a, 'gone@e6.test', 'Admin')),
    ('groomer', app.issue_access_invitation(a, 'groomer@e6.test', 'Groomer')),
    ('susp', app.issue_access_invitation(a, 'suspended-member@e6.test', 'Pemilik')),
    ('expired', app.issue_access_invitation(a, 'expired@e6.test', 'Admin')),
    ('owner', app.issue_access_invitation(a, 'new-owner@e6.test', 'Pemilik')),
    ('inactive_org', app.issue_access_invitation(s, 'late@e6.test', 'Admin')),
    ('reissue1', app.issue_access_invitation(a, 'reissue@e6.test', 'Admin'));
  insert into tok values ('reissue2', app.issue_access_invitation(a, 'reissue@e6.test', 'Admin'));
  perform pg_temp.ok((select status from public.platform_access_invitations where token_hash = encode(extensions.digest((select v from tok where k = 'reissue1'), 'sha256'), 'hex')) = 'revoked', 're-issuing to the same e-mail revokes the older pending link');
  update public.platform_access_invitations set expires_at = now() - interval '1 minute' where token_hash = encode(extensions.digest((select v from tok where k = 'expired'), 'sha256'), 'hex');
  perform app.set_operro_organization_status(s, 'suspended', 'E6 readiness');
  perform pg_temp.expect(format('select app.issue_access_invitation(%L, %L, %L)', s, 'another@e6.test', 'Admin'), '22023', 'no invitation can be issued for a suspended workspace');
end $$;

-- the invited user claims with a verified e-mail: membership, role and active organization follow
select pg_temp.claims(pg_temp.u(4), null);
set local role authenticated;
do $$
declare org uuid; a uuid := current_setting('e6.a')::uuid;
begin
  org := app.claim_access_invitation((select v from tok where k = 'invitee1'));
  perform pg_temp.ok(org = a, 'claim returns the organization');
  perform pg_temp.ok(pg_temp.member(pg_temp.u(4), a) = 'active:Admin', 'an active membership with the invited role exists');
  perform pg_temp.ok(pg_temp.active_org(pg_temp.u(4)) is not distinct from a, 'the active organization is set');
  perform pg_temp.expect(format('select app.claim_access_invitation(%L)', (select v from tok where k = 'invitee1')), '22023', 'a used link cannot be claimed again');
  perform pg_temp.ok(not app.is_business_owner(a), 'an Admin invitation never makes an owner');
  perform pg_temp.ok(not app.has_permission('roles.manage') and not app.has_permission('users.manage'), 'the new Admin holds neither roles.manage nor users.manage');
end $$;

-- wrong, unverified and deactivated identities cannot use someone else's link
select pg_temp.claims(pg_temp.u(7), null);
do $$ begin
  perform pg_temp.expect(format('select app.claim_access_invitation(%L)', (select v from tok where k = 'wrong')), '42501', 'another person''s link is refused (wrong e-mail)');
  perform pg_temp.ok(pg_temp.member_count(pg_temp.u(7)) = 0, 'and no membership was created');
end $$;
select pg_temp.claims(pg_temp.u(6), null);
do $$ begin
  perform pg_temp.expect(format('select app.claim_access_invitation(%L)', (select v from tok where k = 'unver')), '42501', 'an unverified e-mail cannot claim');
end $$;
select pg_temp.claims(pg_temp.u(10), null);
do $$ begin
  perform pg_temp.expect(format('select app.claim_access_invitation(%L)', (select v from tok where k = 'gone')), '42501', 'a deactivated user cannot claim');
end $$;
-- e-mail comparison ignores case
select pg_temp.claims(pg_temp.u(8), null);
do $$ begin
  perform app.claim_access_invitation((select v from tok where k = 'mixed'));
  perform pg_temp.ok(pg_temp.member(pg_temp.u(8), current_setting('e6.a')::uuid) = 'active:Bantuan Operro', 'e-mail matching is case-insensitive and grants exactly the invited role');
end $$;
-- a person who already belongs to another business can join a second one without losing the first
select pg_temp.claims(pg_temp.u(9), (select current_setting('e6.b')::uuid));
do $$ begin
  perform app.claim_access_invitation((select v from tok where k = 'multi'));
  perform pg_temp.ok(pg_temp.member_count(pg_temp.u(9)) = 2, 'multi-organization: both memberships are active');
  perform pg_temp.ok(pg_temp.active_org(pg_temp.u(9)) = current_setting('e6.a')::uuid, 'the claim switches the active organization to the invited one');
  perform pg_temp.claims(pg_temp.u(9), current_setting('e6.b')::uuid);
  perform pg_temp.ok(app.has_membership() and app.is_groomer_member(), 'the first membership still works when selected');
end $$;
-- an old link must not reactivate a suspended member or change their role
select pg_temp.claims(pg_temp.u(12), null);
do $$ begin
  perform pg_temp.expect(format('select app.claim_access_invitation(%L)', (select v from tok where k = 'susp')), '22023', 'an existing (suspended) member cannot be reactivated by an older link');
  perform pg_temp.ok(pg_temp.member(pg_temp.u(12), current_setting('e6.a')::uuid) = 'suspended:Admin', 'the suspended membership stays suspended and keeps its role (the link named Pemilik)');
end $$;
-- expired, revoked-by-reissue, suspended workspace
reset role;
select pg_temp.claims(pg_temp.u(5), null);
set local role authenticated;
do $$ begin
  perform pg_temp.expect(format('select app.claim_access_invitation(%L)', (select v from tok where k = 'expired')), '22023', 'an expired link is unavailable (the e-mail does not matter)');
end $$;
reset role;
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (pg_temp.u(20), 'expired@e6.test', '{}', now()), (pg_temp.u(21), 'reissue@e6.test', '{}', now()), (pg_temp.u(22), 'late@e6.test', '{}', now()), (pg_temp.u(23), 'new-owner@e6.test', '{}', now());
update public.users set status = 'active' where id in (pg_temp.u(20), pg_temp.u(21), pg_temp.u(22), pg_temp.u(23));
select pg_temp.claims(pg_temp.u(20), null);
set local role authenticated;
do $$ begin
  perform pg_temp.expect(format('select app.claim_access_invitation(%L)', (select v from tok where k = 'expired')), '22023', 'an expired link is unavailable');
end $$;
select pg_temp.claims(pg_temp.u(21), null);
do $$ begin
  perform pg_temp.expect(format('select app.claim_access_invitation(%L)', (select v from tok where k = 'reissue1')), '22023', 'the revoked older link is unavailable');
  perform app.claim_access_invitation((select v from tok where k = 'reissue2'));
  perform pg_temp.ok(pg_temp.member_count(pg_temp.u(21)) = 1, 'the newest link works');
end $$;
select pg_temp.claims(pg_temp.u(22), null);
do $$ begin
  perform pg_temp.expect(format('select app.claim_access_invitation(%L)', (select v from tok where k = 'inactive_org')), '22023', 'a link for a workspace suspended after issuing cannot be claimed');
  perform pg_temp.ok(pg_temp.member_count(pg_temp.u(22)) = 0, 'and creates no membership');
end $$;
-- malformed and probing tokens
do $$
declare t text;
begin
  foreach t in array array['', 'abc', repeat('A', 64), repeat('g', 64), repeat('a', 63), repeat('a', 65), repeat('a', 64) || E'\n', '%', 'x'' or 1=1 --', repeat('0', 64)] loop
    perform pg_temp.expect(format('select app.claim_access_invitation(%L)', t), '22023', format('malformed or unknown token %L refused', left(t, 12)));
  end loop;
  perform pg_temp.expect('select app.claim_access_invitation(null)', '22023', 'a null token is refused');
end $$;
-- a new owner invitation produces an owner, and only that
select pg_temp.claims(pg_temp.u(23), null);
do $$ begin
  perform app.claim_access_invitation((select v from tok where k = 'owner'));
  perform pg_temp.claims(pg_temp.u(23), current_setting('e6.a')::uuid);
  perform pg_temp.ok(app.is_business_owner(current_setting('e6.a')::uuid) and not app.is_operro_owner(), 'a Pemilik invitation makes a business owner but never the platform owner');
end $$;
-- groomer invite: a groomer membership exists, but the app-level groomer rules still need a linked staff resource
select pg_temp.claims(pg_temp.u(11), null);
do $$ begin
  perform app.claim_access_invitation((select v from tok where k = 'groomer'));
  perform pg_temp.claims(pg_temp.u(11), current_setting('e6.a')::uuid);
  perform pg_temp.ok(app.is_groomer_member() and not app.has_permission('finance.read') and not app.has_permission('payroll.read'), 'a Groomer invitation yields a groomer with no finance or payroll access');
end $$;
reset role;

-- ===== Structure ============================================================================================================
do $$ begin
  perform pg_temp.ok(not has_function_privilege('anon', 'app.claim_access_invitation(text)', 'execute') and not has_function_privilege('anon', 'app.issue_access_invitation(uuid,text,text)', 'execute') and not has_function_privilege('anon', 'app.list_access_invitations(uuid)', 'execute'), 'anon holds no execute on the invitation functions');
  perform pg_temp.ok(not has_table_privilege('authenticated', 'public.platform_access_invitations', 'select') and not has_table_privilege('authenticated', 'public.platform_access_invitations', 'insert'), 'clients cannot read or write the invitation table directly');
  perform pg_temp.ok(pg_temp.invites('accepted') = 6, 'exactly the six legitimate claims were accepted in this run');
end $$;
rollback;
