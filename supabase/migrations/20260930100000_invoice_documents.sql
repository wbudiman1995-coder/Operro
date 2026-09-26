-- Section 27 — invoice documents and customer communication.
--
-- The pricing/discount/invoice-lifecycle engine is solid and reused as-is
-- (invoice_lines.pricing_breakdown, groomer_name_snapshot, document_type,
-- billing_mode). Everything about presenting an invoice as a branded,
-- printable, WhatsApp-shareable customer document is genuinely new; this
-- migration adds only the schema a document renderer cannot do without:
-- branding/bank-account/template config and one customer-facing notes field.
begin;

-- =====================================================================
-- Branding + WhatsApp templates + membership terms: organizations.settings
-- jsonb already exists (20260721000200_identity_access.sql:100) and is the
-- established place for org-wide soft config (see 20260721000... demo seed
-- storing currency/timezone there) — no new columns for these.
-- =====================================================================
create or replace function app.update_invoice_document_settings(
  p_tagline text, p_logo_attachment uuid, p_membership_terms text,
  p_wa_paid_template text, p_wa_outstanding_template text, p_wa_subscription_template text)
returns public.organizations language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_row public.organizations; v_settings jsonb;
begin
  if v_org is null or not app.has_membership() or not app.has_permission('settings.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_logo_attachment is not null and not exists (
    select 1 from public.attachments where organization_id = v_org and id = p_logo_attachment and deleted_at is null
  ) then
    raise exception 'logo_attachment_not_found' using errcode = 'P0002';
  end if;
  select settings into v_settings from public.organizations where id = v_org for update;
  v_settings := jsonb_set(v_settings, '{documents}', jsonb_build_object(
    'tagline', left(nullif(trim(p_tagline),''), 200),
    'logo_attachment_id', p_logo_attachment,
    'membership_terms', left(nullif(trim(p_membership_terms),''), 8000),
    'whatsapp_templates', jsonb_build_object(
      'paid_completion', left(nullif(trim(p_wa_paid_template),''), 2000),
      'outstanding', left(nullif(trim(p_wa_outstanding_template),''), 2000),
      'subscription_billing', left(nullif(trim(p_wa_subscription_template),''), 2000)
    )
  ), true);
  update public.organizations set settings = v_settings where id = v_org returning * into v_row;
  return v_row;
end $$;

-- =====================================================================
-- Bank accounts (payment instructions) — up to two per organization.
-- =====================================================================
create table public.organization_bank_accounts (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  bank_name       text        not null,
  account_number  text        not null,
  account_holder  text        not null,
  is_primary      boolean     not null default false,
  sort_order      integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_organization_bank_accounts primary key (id),
  constraint fk_org_bank_accounts_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint chk_org_bank_accounts_fields check (length(trim(bank_name)) > 0 and length(trim(account_number)) > 0 and length(trim(account_holder)) > 0)
);
create index idx_org_bank_accounts_org on public.organization_bank_accounts (organization_id) where deleted_at is null;

create trigger trg_org_bank_accounts_updated_at before update on public.organization_bank_accounts
  for each row execute function app.tg_set_updated_at();
create trigger trg_org_bank_accounts_audit_cols before insert or update on public.organization_bank_accounts
  for each row execute function app.tg_set_audit_columns();
create trigger trg_org_bank_accounts_audit after insert or update or delete on public.organization_bank_accounts
  for each row execute function app.tg_write_audit();

alter table public.organization_bank_accounts enable row level security;
create policy organization_bank_accounts_org_isolation on public.organization_bank_accounts for all
  using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()))
  with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()));
create policy organization_bank_accounts_write on public.organization_bank_accounts as restrictive for all
  using (app.is_platform_admin() or app.has_permission('settings.manage'))
  with check (app.is_platform_admin() or app.has_permission('settings.manage'));

create or replace function app.upsert_organization_bank_account(
  p_id uuid, p_bank_name text, p_account_number text, p_account_holder text, p_is_primary boolean, p_sort_order integer)
returns public.organization_bank_accounts language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_row public.organization_bank_accounts; v_count integer;
begin
  if v_org is null or not app.has_membership() or not app.has_permission('settings.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_bank_name,''))) = 0 or length(trim(coalesce(p_account_number,''))) = 0 or length(trim(coalesce(p_account_holder,''))) = 0 then
    raise exception 'invalid_bank_account' using errcode = '22023';
  end if;
  -- Serialize concurrent "add new account" calls for this org so the cap-of-2
  -- count-then-insert below cannot race into 3 rows (same class of fix as
  -- app.record_payment's request_key race).
  perform pg_advisory_xact_lock(hashtext(v_org::text || ':bank_accounts'));
  if p_id is null then
    select count(*) into v_count from public.organization_bank_accounts where organization_id = v_org and deleted_at is null;
    if v_count >= 2 then raise exception 'bank_account_limit_reached' using errcode = '55000'; end if;
    insert into public.organization_bank_accounts (organization_id, bank_name, account_number, account_holder, is_primary, sort_order)
    values (v_org, trim(p_bank_name), trim(p_account_number), trim(p_account_holder), coalesce(p_is_primary,false), coalesce(p_sort_order,0))
    returning * into v_row;
  else
    update public.organization_bank_accounts set
      bank_name = trim(p_bank_name), account_number = trim(p_account_number), account_holder = trim(p_account_holder),
      is_primary = coalesce(p_is_primary,false), sort_order = coalesce(p_sort_order,0), updated_by = auth.uid()
    where organization_id = v_org and id = p_id and deleted_at is null
    returning * into v_row;
    if not found then raise exception 'bank_account_not_found' using errcode = 'P0002'; end if;
  end if;
  if v_row.is_primary then
    update public.organization_bank_accounts set is_primary = false where organization_id = v_org and id <> v_row.id and deleted_at is null;
  end if;
  return v_row;
end $$;

create or replace function app.delete_organization_bank_account(p_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization();
begin
  if v_org is null or not app.has_membership() or not app.has_permission('settings.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  update public.organization_bank_accounts set deleted_at = now(), updated_by = auth.uid()
    where organization_id = v_org and id = p_id and deleted_at is null;
  if not found then raise exception 'bank_account_not_found' using errcode = 'P0002'; end if;
end $$;

-- =====================================================================
-- Customer-facing groomer notes: distinct from invoices.admin_notes, which
-- is explicitly internal-only (invoice-studio.tsx:52, "Hanya terlihat oleh
-- tim internal"). Nullable, editable through the SAME unpaid-invoice window
-- as the other document fields (app.update_unpaid_invoice_details already
-- guards that window) — extended in place rather than duplicated.
-- =====================================================================
alter table public.invoices add column customer_notes text;

create or replace function app.update_invoice_customer_notes(p_invoice uuid, p_revision integer, p_customer_notes text)
returns public.invoices language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_row public.invoices;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('invoice.issue') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.invoices where organization_id = v_org and id = p_invoice for update;
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  if not app.has_branch(v_row.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_row.status <> 'issued' or exists(select 1 from public.payments where organization_id = v_org and invoice_id = v_row.id and status = 'succeeded') then
    raise exception 'invoice_locked' using errcode = '55000';
  end if;
  if v_row.revision <> p_revision then raise exception 'stale_invoice' using errcode = '40001'; end if;
  update public.invoices set customer_notes = left(nullif(trim(p_customer_notes),''), 2000), revision = revision + 1
    where id = v_row.id returning * into v_row;
  return v_row;
end $$;

-- Logo upload reuses the private 'attachments' bucket under a distinct
-- settings.manage-gated policy (same additive pattern as the payment-proof
-- policy in 20260928100000).
create policy attachments_objects_insert_branding on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('settings.manage')
  );

revoke all on function
  app.update_invoice_document_settings(text,uuid,text,text,text,text),
  app.upsert_organization_bank_account(uuid,text,text,text,boolean,integer),
  app.delete_organization_bank_account(uuid),
  app.update_invoice_customer_notes(uuid,integer,text)
from public;
grant execute on function
  app.update_invoice_document_settings(text,uuid,text,text,text,text),
  app.upsert_organization_bank_account(uuid,text,text,text,boolean,integer),
  app.delete_organization_bank_account(uuid),
  app.update_invoice_customer_notes(uuid,integer,text)
to authenticated;

notify pgrst, 'reload schema';
commit;
