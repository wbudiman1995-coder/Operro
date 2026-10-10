-- E2.3 WhatsApp draft center (parity #34).
--
-- A tenant-scoped queue of wa.me drafts for four existing sources (invoice, follow-up, renewal,
-- onboarding invitation) and a USER-REPORTED lifecycle: draft -> opened -> marked_sent | failed | canceled.
-- Operro never sends, scrapes or calls any WhatsApp API: "opened" means a person clicked the wa.me link and
-- "marked_sent" is what that person reports. Neither is provider-confirmed delivery.
--
-- Recipient phone is derived here from the customer row (never trusted from the browser). A customer who
-- has opted out, has no usable phone, or is archived cannot receive a new draft, and existing drafts for
-- them cannot be opened or marked sent. Onboarding invitations have no recipient and no stored secret: the
-- single-use link is only ever in the message the person copies at creation time, so the stored text carries a
-- redaction marker instead.
-- Every status change is an UPDATE on whatsapp_drafts and therefore lands in app.audit_log (existing trigger).
begin;

-- The shared audit trigger records NEW.id; the preference table is keyed by customer, so it gets its own writer.
create function app.tg_write_audit_pk() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row jsonb; v_old jsonb; v_new jsonb;
begin
  if tg_op = 'DELETE' then v_row := to_jsonb(old); v_old := v_row;
  elsif tg_op = 'UPDATE' then v_row := to_jsonb(new); v_old := to_jsonb(old); v_new := v_row;
  else v_row := to_jsonb(new); v_new := v_row; end if;
  insert into app.audit_log (organization_id, actor_id, action, entity_table, entity_id, diff)
  values ((v_row ->> 'organization_id')::uuid, app.fn_current_user_id(), tg_op, tg_table_name, (v_row ->> 'customer_id')::uuid,
          jsonb_strip_nulls(jsonb_build_object('old', v_old, 'new', v_new)));
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function app.tg_write_audit_pk() from public, anon, authenticated;

create table public.whatsapp_contact_preferences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null,
  opted_out_at timestamptz not null default now(),
  opted_out_by uuid,
  primary key (organization_id, customer_id),
  constraint fk_whatsapp_pref_customer foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade
);

create table public.whatsapp_drafts (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_type text not null check (source_type in ('invoice','followup','renewal','onboarding')),
  source_id uuid not null,
  customer_id uuid,
  recipient_phone text check (recipient_phone is null or recipient_phone ~ '^[1-9][0-9]{7,14}$'),
  message_text text not null check (length(message_text) between 1 and 1500),
  status text not null default 'draft' check (status in ('draft','opened','marked_sent','failed','canceled')),
  status_note text check (status_note is null or length(status_note) <= 300),
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  constraint uq_whatsapp_drafts_org_id unique (organization_id, id),
  constraint fk_whatsapp_drafts_customer foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade,
  constraint chk_whatsapp_drafts_recipient check (
    (source_type = 'onboarding' and customer_id is null and recipient_phone is null)
    or (source_type <> 'onboarding' and customer_id is not null and recipient_phone is not null))
);
-- One live (draft/opened/failed) draft per source: creating again is idempotent. Terminal drafts do not block a new one.
create unique index uq_whatsapp_drafts_active on public.whatsapp_drafts (organization_id, source_type, source_id)
  where status in ('draft','opened','failed');
create index idx_whatsapp_drafts_org_created on public.whatsapp_drafts (organization_id, created_at desc, id desc);
create index idx_whatsapp_drafts_org_status on public.whatsapp_drafts (organization_id, status, created_at desc);

create trigger trg_whatsapp_drafts_updated_at before update on public.whatsapp_drafts
  for each row execute function app.tg_set_updated_at();
create trigger trg_whatsapp_drafts_audit after insert or update or delete on public.whatsapp_drafts
  for each row execute function app.tg_write_audit();
create trigger trg_whatsapp_pref_audit after insert or update or delete on public.whatsapp_contact_preferences
  for each row execute function app.tg_write_audit_pk();

alter table public.whatsapp_drafts enable row level security;
alter table public.whatsapp_contact_preferences enable row level security;
revoke all on public.whatsapp_drafts, public.whatsapp_contact_preferences from public, anon, authenticated;
grant select on public.whatsapp_drafts, public.whatsapp_contact_preferences to authenticated;

-- Which capability reads/handles drafts of a source: the capability that already shows that source.
create function app.whatsapp_source_permitted(p_source_type text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_membership() and case p_source_type
    when 'invoice'    then app.has_permission('finance.read')
    when 'followup'   then app.has_permission('customer.read')
    when 'renewal'    then app.has_permission('membership.read')
    when 'onboarding' then app.has_permission('customer.manage')
    else false end;
$$;
revoke all on function app.whatsapp_source_permitted(text) from public, anon, authenticated;
grant execute on function app.whatsapp_source_permitted(text) to authenticated;

create policy whatsapp_drafts_read on public.whatsapp_drafts for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.whatsapp_source_permitted(source_type)));
create policy whatsapp_pref_read on public.whatsapp_contact_preferences for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership() and app.has_permission('customer.read')));

-- Digits for wa.me, mirroring apps/web buildWhatsAppUrl: strip non-digits, leading 0 -> 62, 8..15 digits.
create function app.whatsapp_normalize_phone(p_phone text) returns text
language sql immutable set search_path = '' as $$
  select case
    when d is null or length(d) < 8 then null
    when left(d, 1) = '0' then '62' || substr(d, 2)
    else d end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as d) s
  where length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) between 8 and 15
$$;
revoke all on function app.whatsapp_normalize_phone(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Create (idempotent per live source).  Returns {id, created}.
-- ---------------------------------------------------------------------------
create function app.create_whatsapp_draft(p_source_type text, p_source_id uuid, p_message text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_customer uuid;
  v_phone text;
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

  if p_source_type = 'invoice' then
    select i.customer_id into v_customer from public.invoices i
     where i.organization_id = v_org and i.id = p_source_id and i.status in ('issued','paid');
  elsif p_source_type = 'followup' then
    select c.id into v_customer from public.customers c where c.organization_id = v_org and c.id = p_source_id;
  elsif p_source_type = 'renewal' then
    select cp.customer_id into v_customer from public.customer_packages cp
     where cp.organization_id = v_org and cp.id = p_source_id and cp.deleted_at is null and cp.status <> 'canceled';
  elsif p_source_type = 'onboarding' then
    perform 1 from public.customer_onboarding_links l where l.organization_id = v_org and l.id = p_source_id and l.status = 'active';
    if not found then raise exception 'source_not_found' using errcode = 'P0002'; end if;
  else
    raise exception 'invalid_source_type' using errcode = '22023';
  end if;

  if p_source_type <> 'onboarding' then
    if v_customer is null then raise exception 'source_not_found' using errcode = 'P0002'; end if;
    select app.whatsapp_normalize_phone(c.phone) into v_phone from public.customers c
     where c.organization_id = v_org and c.id = v_customer and c.deleted_at is null;
    if not found then raise exception 'source_archived' using errcode = '22023'; end if;
    if exists (select 1 from public.whatsapp_contact_preferences p where p.organization_id = v_org and p.customer_id = v_customer) then
      raise exception 'recipient_opted_out' using errcode = '22023'; end if;
    if v_phone is null then raise exception 'recipient_phone_missing' using errcode = '22023'; end if;
  elsif v_msg ~* '/join/[A-Za-z0-9_-]{16,}' then
    raise exception 'secret_in_message' using errcode = '22023';
  end if;

  select * into v_existing from public.whatsapp_drafts d
   where d.organization_id = v_org and d.source_type = p_source_type and d.source_id = p_source_id
     and d.status in ('draft','opened','failed');
  if found then return jsonb_build_object('id', v_existing.id, 'created', false); end if;

  insert into public.whatsapp_drafts(organization_id, source_type, source_id, customer_id, recipient_phone, message_text, status_changed_by, created_by)
  values (v_org, p_source_type, p_source_id, v_customer, v_phone, v_msg, app.fn_current_user_id(), app.fn_current_user_id())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'created', true);
end $$;

-- ---------------------------------------------------------------------------
-- Status changes. Same status again is a no-op (double clicks, retries). Allowed:
--   draft -> opened | marked_sent | failed | canceled
--   opened -> opened | marked_sent | failed | canceled
--   failed -> draft (retry) | canceled
--   marked_sent, canceled: terminal
-- opened / marked_sent additionally require a live recipient (not opted out, not archived).
-- ---------------------------------------------------------------------------
create function app.set_whatsapp_draft_status(p_id uuid, p_status text, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_draft public.whatsapp_drafts;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_id is null or p_status not in ('draft','opened','marked_sent','failed','canceled')
     or (v_note is not null and (length(v_note) > 300 or v_note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]')) then
    raise exception 'invalid_status' using errcode = '22023'; end if;

  select d.* into v_draft from public.whatsapp_drafts d where d.organization_id = v_org and d.id = p_id for update;
  if not found or not app.whatsapp_source_permitted(v_draft.source_type) then
    raise exception 'draft_not_found' using errcode = 'P0002'; end if;

  if v_draft.status = p_status then return v_draft.status; end if;
  if not ((v_draft.status = 'draft' and p_status in ('opened','marked_sent','failed','canceled'))
       or (v_draft.status = 'opened' and p_status in ('marked_sent','failed','canceled'))
       or (v_draft.status = 'failed' and p_status in ('draft','canceled'))) then
    raise exception 'invalid_transition' using errcode = '22023'; end if;

  if p_status in ('opened','marked_sent') and v_draft.customer_id is not null then
    if exists (select 1 from public.whatsapp_contact_preferences p where p.organization_id = v_org and p.customer_id = v_draft.customer_id) then
      raise exception 'recipient_opted_out' using errcode = '22023'; end if;
    if not exists (select 1 from public.customers c where c.organization_id = v_org and c.id = v_draft.customer_id and c.deleted_at is null) then
      raise exception 'source_archived' using errcode = '22023'; end if;
  end if;

  update public.whatsapp_drafts
     set status = p_status, status_note = v_note, status_changed_at = now(), status_changed_by = app.fn_current_user_id()
   where id = v_draft.id;
  return p_status;
end $$;

-- Opt-out is a customer-level fact; opting out cancels that customer's live drafts (audited like any status change).
create function app.set_whatsapp_opt_out(p_customer uuid, p_opted_out boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_cancelled integer := 0;
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm') or not app.has_permission('customer.manage') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_customer is null or p_opted_out is null then raise exception 'invalid_status' using errcode = '22023'; end if;
  perform 1 from public.customers c where c.organization_id = v_org and c.id = p_customer for share;
  if not found then raise exception 'source_not_found' using errcode = 'P0002'; end if;
  if p_opted_out then
    insert into public.whatsapp_contact_preferences(organization_id, customer_id, opted_out_by)
    values (v_org, p_customer, app.fn_current_user_id()) on conflict do nothing;
    update public.whatsapp_drafts
       set status = 'canceled', status_note = 'Pelanggan berhenti menerima pesan WhatsApp', status_changed_at = now(),
           status_changed_by = app.fn_current_user_id()
     where organization_id = v_org and customer_id = p_customer and status in ('draft','opened','failed');
    get diagnostics v_cancelled = row_count;
  else
    delete from public.whatsapp_contact_preferences where organization_id = v_org and customer_id = p_customer;
  end if;
  return v_cancelled;
end $$;

revoke all on function app.create_whatsapp_draft(text, uuid, text), app.set_whatsapp_draft_status(uuid, text, text),
  app.set_whatsapp_opt_out(uuid, boolean) from public, anon, authenticated;
grant execute on function app.create_whatsapp_draft(text, uuid, text), app.set_whatsapp_draft_status(uuid, text, text),
  app.set_whatsapp_opt_out(uuid, boolean) to authenticated;

-- Make the new RPCs visible to PostgREST without waiting for its schema-cache refresh.
notify pgrst, 'reload schema';
commit;
