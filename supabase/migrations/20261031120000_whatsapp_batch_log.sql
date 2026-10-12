-- P3: WhatsApp batch workflow + manual delivery log (parity #34), built ON the E2.3 draft contract.
--
-- Still NO sending, scraping or provider call: Operro creates drafts, a person opens each wa.me link and REPORTS the
-- outcome. Nothing here can mean "delivered" or "read" - those statuses do not exist in the draft contract, and this
-- migration adds none. A provider webhook would be a separate, explicitly configured integration (see the handoff).
--
-- Adds
--   * whatsapp_batches            a named group of drafts created together (invoice / follow-up / renewal sources only;
--                                 onboarding drafts stay single because their one-time link must never be stored).
--   * whatsapp_drafts.batch_id    nullable link from a draft to its batch.
--   * whatsapp_draft_events       APPEND-ONLY log of every draft creation and status change (who, when, from -> to, note,
--                                 batch). Written by a trigger, so single-draft actions, batch actions and the opt-out
--                                 cancellation are all logged the same way. Retries (failed -> draft) are therefore visible.
--   * app.whatsapp_resolve_recipient   the ONE eligibility rule (source exists and is billable/active, customer not archived,
--                                 not opted out, usable phone) shared by create, preview and batch.
--   * app.preview_whatsapp_batch / app.create_whatsapp_batch / app.cancel_whatsapp_batch
--   * app.create_whatsapp_draft   re-created to delegate to the shared rule; same inputs, same errors, same result.
-- Authority is the existing per-source capability (app.whatsapp_source_permitted) plus the crm module; the organization comes
-- only from the session. Batches are bounded to 25 sources. Clients get SELECT only on the new tables.
begin;

create table public.whatsapp_batches (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_type text not null check (source_type in ('invoice','followup','renewal')),
  status text not null default 'open' check (status in ('open','canceled')),
  draft_count integer not null default 0 check (draft_count between 0 and 25),
  existing_count integer not null default 0 check (existing_count between 0 and 25),
  skipped_count integer not null default 0 check (skipped_count between 0 and 25),
  canceled_count integer not null default 0 check (canceled_count between 0 and 25),
  created_by uuid,
  created_at timestamptz not null default now(),
  canceled_by uuid,
  canceled_at timestamptz,
  constraint uq_whatsapp_batches_org_id unique (organization_id, id),
  constraint chk_whatsapp_batches_canceled check ((status = 'canceled') = (canceled_at is not null))
);
create index idx_whatsapp_batches_org_created on public.whatsapp_batches (organization_id, created_at desc, id desc);

alter table public.whatsapp_drafts add column batch_id uuid;
alter table public.whatsapp_drafts add constraint fk_whatsapp_drafts_batch
  foreign key (organization_id, batch_id) references public.whatsapp_batches (organization_id, id);
create index idx_whatsapp_drafts_batch on public.whatsapp_drafts (organization_id, batch_id, created_at desc, id desc) where batch_id is not null;

create table public.whatsapp_draft_events (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  draft_id uuid not null,
  batch_id uuid,
  source_type text not null check (source_type in ('invoice','followup','renewal','onboarding')),
  from_status text check (from_status in ('draft','opened','marked_sent','failed','canceled')),
  to_status text not null check (to_status in ('draft','opened','marked_sent','failed','canceled')),
  note text check (note is null or length(note) <= 300),
  actor_id uuid,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint fk_whatsapp_events_draft foreign key (organization_id, draft_id) references public.whatsapp_drafts (organization_id, id) on delete cascade
);
create index idx_whatsapp_events_draft on public.whatsapp_draft_events (organization_id, draft_id, occurred_at, id);
create index idx_whatsapp_events_org_time on public.whatsapp_draft_events (organization_id, occurred_at desc, id desc);

create function app.tg_whatsapp_events_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'whatsapp delivery log is append-only' using errcode = 'restrict_violation'; end $$;
-- Deleting a draft cascades to its events only when the organization itself is removed; direct edits are refused.
create trigger trg_whatsapp_events_no_update before update on public.whatsapp_draft_events
  for each row execute function app.tg_whatsapp_events_append_only();

create function app.tg_whatsapp_draft_event() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.whatsapp_draft_events(organization_id, draft_id, batch_id, source_type, from_status, to_status, note, actor_id)
    values (new.organization_id, new.id, new.batch_id, new.source_type, null, new.status, new.status_note, coalesce(new.status_changed_by, new.created_by));
  elsif new.status is distinct from old.status then
    insert into public.whatsapp_draft_events(organization_id, draft_id, batch_id, source_type, from_status, to_status, note, actor_id)
    values (new.organization_id, new.id, new.batch_id, new.source_type, old.status, new.status, new.status_note, new.status_changed_by);
  end if;
  return new;
end $$;
create trigger trg_whatsapp_drafts_event after insert or update of status on public.whatsapp_drafts
  for each row execute function app.tg_whatsapp_draft_event();
create trigger trg_whatsapp_batches_audit after insert or update on public.whatsapp_batches
  for each row execute function app.tg_write_audit();

alter table public.whatsapp_batches enable row level security;
alter table public.whatsapp_draft_events enable row level security;
revoke all on public.whatsapp_batches, public.whatsapp_draft_events from public, anon, authenticated;
grant select on public.whatsapp_batches, public.whatsapp_draft_events to authenticated;
create policy whatsapp_batches_read on public.whatsapp_batches for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.whatsapp_source_permitted(source_type)));
create policy whatsapp_events_read on public.whatsapp_draft_events for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.whatsapp_source_permitted(source_type)));

-- Backfill: drafts that already exist get a creation event (their current status), so history is never empty.
insert into public.whatsapp_draft_events(organization_id, draft_id, batch_id, source_type, from_status, to_status, note, actor_id, occurred_at)
select d.organization_id, d.id, null, d.source_type, null, d.status, d.status_note, coalesce(d.status_changed_by, d.created_by), d.status_changed_at
  from public.whatsapp_drafts d;

-- ---------------------------------------------------------------------------------------------------------------
-- The shared eligibility rule. Returns exactly one row; reason is NULL when the source can receive a draft.
--   invalid_source_type | source_not_found | source_archived | recipient_opted_out | recipient_phone_missing
-- Onboarding invitations have no recipient: customer and phone are NULL and only the active link is checked.
-- ---------------------------------------------------------------------------------------------------------------
create function app.whatsapp_resolve_recipient(p_org uuid, p_source_type text, p_source_id uuid)
returns table (customer_id uuid, phone text, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare v_customer uuid; v_phone text;
begin
  if p_source_type = 'invoice' then
    select i.customer_id into v_customer from public.invoices i
     where i.organization_id = p_org and i.id = p_source_id and i.status in ('issued','paid');
  elsif p_source_type = 'followup' then
    select c.id into v_customer from public.customers c where c.organization_id = p_org and c.id = p_source_id;
  elsif p_source_type = 'renewal' then
    select cp.customer_id into v_customer from public.customer_packages cp
     where cp.organization_id = p_org and cp.id = p_source_id and cp.deleted_at is null and cp.status <> 'canceled';
  elsif p_source_type = 'onboarding' then
    perform 1 from public.customer_onboarding_links l where l.organization_id = p_org and l.id = p_source_id and l.status = 'active';
    if not found then return query select null::uuid, null::text, 'source_not_found'::text; return; end if;
    return query select null::uuid, null::text, null::text; return;
  else
    return query select null::uuid, null::text, 'invalid_source_type'::text; return;
  end if;
  if v_customer is null then return query select null::uuid, null::text, 'source_not_found'::text; return; end if;
  select app.whatsapp_normalize_phone(c.phone) into v_phone from public.customers c
   where c.organization_id = p_org and c.id = v_customer and c.deleted_at is null;
  if not found then return query select v_customer, null::text, 'source_archived'::text; return; end if;
  if exists (select 1 from public.whatsapp_contact_preferences p where p.organization_id = p_org and p.customer_id = v_customer) then
    return query select v_customer, v_phone, 'recipient_opted_out'::text; return; end if;
  if v_phone is null then return query select v_customer, null::text, 'recipient_phone_missing'::text; return; end if;
  return query select v_customer, v_phone, null::text;
end $$;
revoke all on function app.whatsapp_resolve_recipient(uuid, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Single draft: same contract as E2.3, now through the shared rule.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function app.create_whatsapp_draft(p_source_type text, p_source_id uuid, p_message text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_r record;
  v_existing public.whatsapp_drafts;
  v_id uuid;
  v_msg text := btrim(coalesce(p_message, ''));
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm') or not app.whatsapp_source_permitted(p_source_type) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_source_id is null or length(v_msg) not between 1 and 1500 or v_msg ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]'
     or v_msg ~ '\{[a-zA-Z_]+\}' then
    raise exception 'invalid_message' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_draft:' || v_org::text || p_source_type || p_source_id::text, 0));

  select * into v_r from app.whatsapp_resolve_recipient(v_org, p_source_type, p_source_id);
  if v_r.reason = 'source_not_found' then raise exception 'source_not_found' using errcode = 'P0002'; end if;
  if v_r.reason is not null then raise exception '%', v_r.reason using errcode = '22023'; end if;
  if p_source_type = 'onboarding' and v_msg ~* '/join/[A-Za-z0-9_-]{16,}' then
    raise exception 'secret_in_message' using errcode = '22023'; end if;

  select * into v_existing from public.whatsapp_drafts d
   where d.organization_id = v_org and d.source_type = p_source_type and d.source_id = p_source_id
     and d.status in ('draft','opened','failed');
  if found then return jsonb_build_object('id', v_existing.id, 'created', false); end if;

  insert into public.whatsapp_drafts(organization_id, source_type, source_id, customer_id, recipient_phone, message_text, status_changed_by, created_by)
  values (v_org, p_source_type, p_source_id, v_r.customer_id, v_r.phone, v_msg, app.fn_current_user_id(), app.fn_current_user_id())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'created', true);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Preview: eligibility per source, no write. At most 25 distinct sources.
-- ---------------------------------------------------------------------------------------------------------------
create function app.preview_whatsapp_batch(p_source_type text, p_source_ids uuid[])
returns table (source_id uuid, eligible boolean, reason text, existing_draft_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_id uuid; v_r record; v_existing uuid; v_seen uuid[] := '{}';
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm') or p_source_type not in ('invoice','followup','renewal')
     or not app.whatsapp_source_permitted(p_source_type) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_source_ids is null or cardinality(p_source_ids) not between 1 and 25 then
    raise exception 'invalid_batch' using errcode = '22023'; end if;
  foreach v_id in array p_source_ids loop
    source_id := v_id;
    if v_id is null then raise exception 'invalid_batch' using errcode = '22023'; end if;
    if v_id = any(v_seen) then eligible := false; reason := 'duplicate_in_request'; existing_draft_id := null; return next; continue; end if;
    v_seen := v_seen || v_id;
    select * into v_r from app.whatsapp_resolve_recipient(v_org, p_source_type, v_id);
    select d.id into v_existing from public.whatsapp_drafts d
     where d.organization_id = v_org and d.source_type = p_source_type and d.source_id = v_id and d.status in ('draft','opened','failed');
    eligible := v_r.reason is null and v_existing is null;
    reason := case when v_r.reason is not null then v_r.reason when v_existing is not null then 'already_in_queue' end;
    existing_draft_id := v_existing;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Create a batch. p_items = [{"source_id": uuid, "message": text}, ...] (1..25). Every item is judged on its own:
--   created | existing (a live draft for that source already exists; left untouched) | skipped (+reason)
-- No batch row is created when nothing was created. Returns {batch_id, created, existing, skipped, results[]}.
-- ---------------------------------------------------------------------------------------------------------------
create function app.create_whatsapp_batch(p_source_type text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_batch uuid;
  v_item jsonb;
  v_src uuid;
  v_msg text;
  v_r record;
  v_existing uuid;
  v_new uuid;
  v_seen uuid[] := '{}';
  v_results jsonb := '[]'::jsonb;
  v_created integer := 0;
  v_existing_n integer := 0;
  v_skipped integer := 0;
  v_outcome text;
  v_reason text;
  v_draft uuid;
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm') or not app.whatsapp_source_permitted(p_source_type) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_source_type not in ('invoice','followup','renewal') or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 25 then
    raise exception 'invalid_batch' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_batch:' || v_org::text, 0));

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_outcome := null; v_reason := null; v_draft := null; v_src := null;
    if jsonb_typeof(v_item) <> 'object' then
      v_outcome := 'skipped'; v_reason := 'invalid_item';
    else
      begin v_src := (v_item ->> 'source_id')::uuid; exception when others then v_src := null; end;
      v_msg := btrim(coalesce(v_item ->> 'message', ''));
      if v_src is null then v_outcome := 'skipped'; v_reason := 'invalid_item';
      elsif v_src = any(v_seen) then v_outcome := 'skipped'; v_reason := 'duplicate_in_request';
      elsif length(v_msg) not between 1 and 1500 or v_msg ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' or v_msg ~ '\{[a-zA-Z_]+\}' then
        v_outcome := 'skipped'; v_reason := 'invalid_message';
      end if;
    end if;
    if v_outcome is null then
      v_seen := v_seen || v_src;
      -- same lock key as the single-draft path, so a concurrent single create and a batch never both insert
      perform pg_advisory_xact_lock(hashtextextended('wa_draft:' || v_org::text || p_source_type || v_src::text, 0));
      select * into v_r from app.whatsapp_resolve_recipient(v_org, p_source_type, v_src);
      if v_r.reason is not null then
        v_outcome := 'skipped'; v_reason := v_r.reason;
      else
        select d.id into v_existing from public.whatsapp_drafts d
         where d.organization_id = v_org and d.source_type = p_source_type and d.source_id = v_src and d.status in ('draft','opened','failed');
        if v_existing is not null then
          v_outcome := 'existing'; v_draft := v_existing;
        else
          if v_batch is null then
            insert into public.whatsapp_batches(organization_id, source_type, created_by) values (v_org, p_source_type, app.fn_current_user_id())
            returning id into v_batch;
          end if;
          insert into public.whatsapp_drafts(organization_id, source_type, source_id, customer_id, recipient_phone, message_text, batch_id, status_changed_by, created_by)
          values (v_org, p_source_type, v_src, v_r.customer_id, v_r.phone, v_msg, v_batch, app.fn_current_user_id(), app.fn_current_user_id())
          returning id into v_new;
          v_outcome := 'created'; v_draft := v_new;
        end if;
      end if;
    end if;
    if v_outcome = 'created' then v_created := v_created + 1;
    elsif v_outcome = 'existing' then v_existing_n := v_existing_n + 1;
    else v_skipped := v_skipped + 1; end if;
    v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('source_id', v_src, 'outcome', v_outcome, 'reason', v_reason, 'draft_id', v_draft)));
  end loop;

  if v_batch is not null then
    update public.whatsapp_batches set draft_count = v_created, existing_count = v_existing_n, skipped_count = v_skipped where id = v_batch;
  end if;
  return jsonb_build_object('batch_id', v_batch, 'created', v_created, 'existing', v_existing_n, 'skipped', v_skipped, 'results', v_results);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Cancel a batch: every still-live draft (draft / opened / failed) becomes canceled; drafts a person already marked as
-- sent are left as they are. Idempotent: a canceled batch returns 0.
-- ---------------------------------------------------------------------------------------------------------------
create function app.cancel_whatsapp_batch(p_batch uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_batch public.whatsapp_batches; v_n integer;
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm') or p_batch is null then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  select b.* into v_batch from public.whatsapp_batches b where b.organization_id = v_org and b.id = p_batch for update;
  if not found or not app.whatsapp_source_permitted(v_batch.source_type) then
    raise exception 'batch_not_found' using errcode = 'P0002'; end if;
  if v_batch.status = 'canceled' then return 0; end if;
  update public.whatsapp_drafts
     set status = 'canceled', status_note = 'Batch dibatalkan', status_changed_at = now(), status_changed_by = app.fn_current_user_id()
   where organization_id = v_org and batch_id = p_batch and status in ('draft','opened','failed');
  get diagnostics v_n = row_count;
  update public.whatsapp_batches
     set status = 'canceled', canceled_at = now(), canceled_by = app.fn_current_user_id(), canceled_count = v_n
   where id = p_batch;
  return v_n;
end $$;

revoke all on function app.tg_whatsapp_events_append_only(), app.tg_whatsapp_draft_event(),
  app.create_whatsapp_draft(text, uuid, text), app.preview_whatsapp_batch(text, uuid[]), app.create_whatsapp_batch(text, jsonb),
  app.cancel_whatsapp_batch(uuid) from public, anon, authenticated;
grant execute on function app.create_whatsapp_draft(text, uuid, text), app.preview_whatsapp_batch(text, uuid[]),
  app.create_whatsapp_batch(text, jsonb), app.cancel_whatsapp_batch(uuid) to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261031120000'::text;
$$;

notify pgrst, 'reload schema';
commit;
