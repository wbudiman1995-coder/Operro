-- E3.3 Safe, bounded, dry-run-first storage cleanup foundation (parity #43).
--
-- Extends the existing retention pattern (metadata.expires_at stamped on styling references and grooming evidence)
-- with a job that can only ever act on a PREVIEWED set, tombstones metadata BEFORE any Storage object is removed,
-- is idempotent and retryable, and cannot run twice at once for one organization. It stores no database-byte
-- estimates and does no billing; "scheduled" means a scheduler can call exactly these functions per organization -
-- nothing here runs unattended.
--
--   preview (dry run)  -> storage_cleanup_runs(mode=dry_run) + items(state=candidate); touches nothing else
--   begin              -> requires a fresh completed preview; one running apply per organization (lease);
--                         re-verifies each previewed item and tombstones attachments.deleted_at FIRST (state=marked);
--                         returns the objects to remove (these plus any marked/failed leftovers from earlier runs)
--   record             -> the runner reports per object: deleted | missing (already absent) | failed (retried later)
--   finish             -> completed when nothing is pending, otherwise partial
-- Protected, never cleaned: attachments linked to invoices, payments, refunds, orders, complaints, payroll,
-- commissions, expenses, packages or memberships, payment proofs, attendance photos, objects outside the
-- organization's own storage prefix, and anything not past its expiry plus a 1 day grace.
begin;

create function app.try_timestamptz(p_text text) returns timestamptz
language plpgsql immutable set search_path = '' as $$
begin
  if p_text is null or p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then return null; end if;
  return p_text::timestamptz;
exception when others then return null;
end $$;

create table public.storage_cleanup_runs (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mode text not null check (mode in ('dry_run','apply')),
  status text not null check (status in ('running','completed','partial','failed','abandoned')),
  dry_run_id uuid,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  deleted_count integer not null default 0 check (deleted_count >= 0),
  missing_count integer not null default 0 check (missing_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  lease_expires_at timestamptz,
  started_by uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  note text check (note is null or length(note) <= 300),
  constraint uq_storage_cleanup_runs_org_id unique (organization_id, id),
  constraint chk_storage_cleanup_dry_run_done check (mode <> 'dry_run' or status = 'completed')
);
create unique index uq_storage_cleanup_one_running on public.storage_cleanup_runs (organization_id)
  where mode = 'apply' and status = 'running';
create index idx_storage_cleanup_runs_org on public.storage_cleanup_runs (organization_id, started_at desc);

create table public.storage_cleanup_items (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  processed_run_id uuid,
  attachment_id uuid not null,
  storage_bucket text not null,
  storage_path text not null,
  reason text not null,
  state text not null check (state in ('candidate','marked','deleted','missing','failed','abandoned')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  last_error text check (last_error is null or length(last_error) <= 300),
  updated_at timestamptz not null default now(),
  constraint fk_storage_cleanup_items_run foreign key (organization_id, run_id) references public.storage_cleanup_runs (organization_id, id) on delete cascade,
  constraint chk_storage_cleanup_items_prefix check (storage_path like organization_id::text || '/%')
);
-- An attachment is pending removal at most once at a time.
create unique index uq_storage_cleanup_pending on public.storage_cleanup_items (attachment_id) where state in ('marked','failed');
create index idx_storage_cleanup_items_run on public.storage_cleanup_items (organization_id, run_id);

create trigger trg_storage_cleanup_runs_audit after insert or update or delete on public.storage_cleanup_runs
  for each row execute function app.tg_write_audit();
create trigger trg_storage_cleanup_items_audit after insert or update or delete on public.storage_cleanup_items
  for each row execute function app.tg_write_audit();

alter table public.storage_cleanup_runs enable row level security;
alter table public.storage_cleanup_items enable row level security;
revoke all on public.storage_cleanup_runs, public.storage_cleanup_items from public, anon, authenticated;
grant select on public.storage_cleanup_runs, public.storage_cleanup_items to authenticated;
create policy storage_cleanup_runs_read on public.storage_cleanup_runs for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership() and app.has_permission('settings.manage')));
create policy storage_cleanup_items_read on public.storage_cleanup_items for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership() and app.has_permission('settings.manage')));

-- ---------------------------------------------------------------------------
-- Eligibility (internal). Expired past a 1 day grace, in an organization-owned path, and not referenced by anything
-- that must outlive the photo.
-- ---------------------------------------------------------------------------
create function app.storage_cleanup_candidates(p_org uuid, p_limit integer)
returns table (attachment_id uuid, storage_bucket text, storage_path text, reason text)
language sql stable security definer set search_path = '' as $$
  select a.id, a.storage_bucket, a.storage_path,
         case when a.metadata ->> 'kind' = 'styling_reference' then 'styling_reference_expired' else 'grooming_evidence_expired' end
    from public.attachments a
   where a.organization_id = p_org and a.deleted_at is null
     and a.storage_bucket in ('attachments','styling-references','onboarding-styling')
     and a.storage_path like p_org::text || '/%'
     and (a.metadata ->> 'kind' = 'styling_reference' or a.metadata ? 'category')
     and app.try_timestamptz(a.metadata ->> 'expires_at') <= now() - interval '1 day'
     and not exists (select 1 from public.attachment_links l where l.organization_id = a.organization_id and l.attachment_id = a.id
                      and l.subject_type in ('invoice','payment','refund','order','complaint','payroll_run','commission','expense','package','membership'))
     and not exists (select 1 from public.payments p where p.organization_id = a.organization_id and p.proof_attachment_id = a.id)
     and not exists (select 1 from public.attendance_records r where r.organization_id = a.organization_id and r.photo_attachment_id = a.id)
   order by a.id
   limit greatest(1, least(coalesce(p_limit, 100), 200));
$$;

create function app.storage_cleanup_authorized(p_apply boolean) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm')
     or not (case when p_apply then app.is_business_owner_member(v_org) else app.has_permission('settings.manage') end) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  return v_org;
end $$;

-- ---------------------------------------------------------------------------
-- Dry run: lists what an apply WOULD do. Changes nothing but its own bookkeeping rows.
-- ---------------------------------------------------------------------------
create function app.storage_cleanup_preview(p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.storage_cleanup_authorized(false); v_run uuid; v_n integer;
begin
  insert into public.storage_cleanup_runs(organization_id, mode, status, started_by, finished_at, note)
  values (v_org, 'dry_run', 'completed', app.fn_current_user_id(), now(), 'Pratinjau: tidak ada yang dihapus')
  returning id into v_run;
  insert into public.storage_cleanup_items(organization_id, run_id, attachment_id, storage_bucket, storage_path, reason, state)
  select v_org, v_run, c.attachment_id, c.storage_bucket, c.storage_path, c.reason, 'candidate'
    from app.storage_cleanup_candidates(v_org, p_limit) c;
  get diagnostics v_n = row_count;
  update public.storage_cleanup_runs set candidate_count = v_n where id = v_run;
  return jsonb_build_object('run_id', v_run, 'candidates', v_n);
end $$;

-- ---------------------------------------------------------------------------
-- Begin an apply run from a fresh preview. Returns the objects the runner must now remove from Storage.
-- ---------------------------------------------------------------------------
create function app.storage_cleanup_begin(p_dry_run uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.storage_cleanup_authorized(true);
  v_preview public.storage_cleanup_runs;
  v_run uuid; v_marked integer := 0; v_skipped integer := 0; v_item record; v_att public.attachments; v_pending jsonb;
begin
  select * into v_preview from public.storage_cleanup_runs where organization_id = v_org and id = p_dry_run;
  if not found or v_preview.mode <> 'dry_run' then raise exception 'preview_not_found' using errcode = 'P0002'; end if;
  if v_preview.started_at < now() - interval '24 hours' then raise exception 'preview_stale' using errcode = '22023'; end if;

  -- Lease: a running run blocks a second one until its lease lapses; a lapsed run is abandoned and its leftovers retried.
  update public.storage_cleanup_runs set status = 'abandoned', finished_at = now(), note = 'Lease habis; sisa dilanjutkan oleh proses berikutnya'
   where organization_id = v_org and mode = 'apply' and status = 'running' and lease_expires_at <= now();
  begin
    insert into public.storage_cleanup_runs(organization_id, mode, status, dry_run_id, candidate_count, lease_expires_at, started_by)
    values (v_org, 'apply', 'running', p_dry_run, v_preview.candidate_count, now() + interval '15 minutes', app.fn_current_user_id())
    returning id into v_run;
  exception when unique_violation then
    raise exception 'cleanup_already_running' using errcode = '55P03';
  end;

  for v_item in select i.* from public.storage_cleanup_items i where i.organization_id = v_org and i.run_id = p_dry_run and i.state = 'candidate' order by i.id loop
    -- Re-verify at apply time: still a candidate right now (not yet touched, still unreferenced, still expired).
    select a.* into v_att from public.attachments a
     where a.organization_id = v_org and a.id = v_item.attachment_id for update;
    if not found or v_att.deleted_at is not null
       or not exists (select 1 from app.storage_cleanup_candidates(v_org, 200) c where c.attachment_id = v_item.attachment_id) then
      v_skipped := v_skipped + 1; continue;
    end if;
    -- METADATA FIRST: the attachment stops being referenced before any object is touched.
    update public.attachments set deleted_at = now(), metadata = metadata || jsonb_build_object('cleanup_run_id', v_run) where id = v_att.id;
    insert into public.storage_cleanup_items(organization_id, run_id, attachment_id, storage_bucket, storage_path, reason, state)
    values (v_org, v_run, v_att.id, v_att.storage_bucket, v_att.storage_path, v_item.reason, 'marked')
    on conflict (attachment_id) where state in ('marked','failed') do nothing;
    v_marked := v_marked + 1;
  end loop;
  update public.storage_cleanup_runs set skipped_count = v_skipped where id = v_run;

  select coalesce(jsonb_agg(jsonb_build_object('item_id', p.id, 'bucket', p.storage_bucket, 'path', p.storage_path) order by p.id), '[]'::jsonb) into v_pending
    from (select * from public.storage_cleanup_items i where i.organization_id = v_org and i.state in ('marked','failed') and i.attempts < 5 order by i.id limit 200) p;
  return jsonb_build_object('run_id', v_run, 'marked', v_marked, 'skipped', v_skipped, 'pending', v_pending);
end $$;

-- ---------------------------------------------------------------------------
-- The runner reports what happened to each object. Idempotent: a settled item never changes again.
-- ---------------------------------------------------------------------------
create function app.storage_cleanup_record(p_run uuid, p_results jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.storage_cleanup_authorized(true); v_r jsonb; v_changed integer := 0; v_n integer; v_result text; v_err text;
begin
  perform 1 from public.storage_cleanup_runs where organization_id = v_org and id = p_run and mode = 'apply' and status = 'running' for update;
  if not found then raise exception 'run_not_running' using errcode = '55000'; end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) > 200 then raise exception 'invalid_results' using errcode = '22023'; end if;
  for v_r in select * from jsonb_array_elements(p_results) loop
    v_result := v_r ->> 'result';
    v_err := left(coalesce(v_r ->> 'error', ''), 300);
    if jsonb_typeof(v_r) <> 'object' or (v_r ->> 'item_id') !~ '^[0-9a-f-]{36}$' or v_result not in ('deleted','missing','failed') then
      raise exception 'invalid_results' using errcode = '22023'; end if;
    update public.storage_cleanup_items i
       set state = case when v_result = 'failed' and i.attempts + 1 >= 5 then 'abandoned' else v_result end,
           attempts = case when v_result = 'failed' then i.attempts + 1 else i.attempts end,
           last_error = case when v_result = 'failed' then nullif(v_err, '') else null end,
           processed_run_id = p_run, updated_at = now()
     where i.organization_id = v_org and i.id = (v_r ->> 'item_id')::uuid and i.state in ('marked','failed');
    get diagnostics v_n = row_count;
    v_changed := v_changed + v_n;
  end loop;
  update public.storage_cleanup_runs set lease_expires_at = now() + interval '15 minutes' where id = p_run;
  return v_changed;
end $$;

create function app.storage_cleanup_finish(p_run uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.storage_cleanup_authorized(true); v_pending integer; v_status text; v_run public.storage_cleanup_runs;
begin
  select * into v_run from public.storage_cleanup_runs where organization_id = v_org and id = p_run and mode = 'apply' for update;
  if not found then raise exception 'run_not_found' using errcode = 'P0002'; end if;
  if v_run.status <> 'running' then return v_run.status; end if;   -- finishing twice is a no-op
  select count(*) into v_pending from public.storage_cleanup_items where organization_id = v_org and state in ('marked','failed','abandoned');
  v_status := case when v_pending = 0 then 'completed' else 'partial' end;
  update public.storage_cleanup_runs r set status = v_status, finished_at = now(), lease_expires_at = null,
    deleted_count = (select count(*) from public.storage_cleanup_items i where i.processed_run_id = p_run and i.state = 'deleted'),
    missing_count = (select count(*) from public.storage_cleanup_items i where i.processed_run_id = p_run and i.state = 'missing'),
    failed_count = v_pending
   where r.id = p_run;
  return v_status;
end $$;

revoke all on function app.try_timestamptz(text), app.storage_cleanup_candidates(uuid, integer), app.storage_cleanup_authorized(boolean)
  from public, anon, authenticated;
revoke all on function app.storage_cleanup_preview(integer), app.storage_cleanup_begin(uuid), app.storage_cleanup_record(uuid, jsonb),
  app.storage_cleanup_finish(uuid) from public, anon, authenticated;
grant execute on function app.storage_cleanup_preview(integer), app.storage_cleanup_begin(uuid), app.storage_cleanup_record(uuid, jsonb),
  app.storage_cleanup_finish(uuid) to authenticated;

-- Make the new RPCs visible to PostgREST without waiting for its schema-cache refresh.
notify pgrst, 'reload schema';
commit;
