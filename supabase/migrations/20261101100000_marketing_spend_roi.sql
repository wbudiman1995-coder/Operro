-- Stream 1: tenant-owned marketing spend and a defined, labelled source return (parity #1).
--
-- Spend. public.marketing_spend_entries is an immutable ledger of amounts a person declares they spent to acquire customers
-- through one named source (for example "Instagram"), on one day, in one currency. Corrections are reversal rows that carry
-- the original day, so a period's net spend stays truthful. Rows are never updated or deleted (a trigger refuses it, even for
-- the table owner). Writes are RPC-only and idempotent by request_key; every row change lands in app.audit_log.
--
-- Return. app.dashboard_source_roi answers exactly one question and says so: for each source and currency, how much cash was
-- collected IN THE PERIOD from customers whose record was created IN THE SAME PERIOD under that source, compared with the net
-- spend recorded for that source in the period.
--   source        the customer's CURRENT stored source, trimmed, whitespace-collapsed and case-folded (the accepted rule of
--                 app.dashboard_source_performance). Customers without a source are never given spend.
--   cohort        non-archived, non-deleted customers created in the period (Jakarta or the supplied zone).
--   collected     payments with status 'succeeded' by paid_at, the accepted dashboard predicate. Customer = invoice customer,
--                 else payment customer.
--   refunded      refunds with status 'succeeded' by refunded_at; currency from the refunded payment.
--   net revenue   collected - refunded. net result = net revenue - spend. ratio = net revenue / spend, only when spend > 0.
-- It is NOT lifetime value, campaign attribution, profit or an accounting return: customers who pay after the period are not
-- counted, and a source label is free text. Currencies are never converted, summed or netted against each other.
--
-- Authority: the organization comes only from the session. Spend is organization-wide (customers carry no branch), so writing
-- needs finance.manage + finance module + branches.all, and reading spend or the return needs finance.read + customer.read
-- (or customer.manage) + the finance and crm modules + branches.all, and not a Groomer-role member.
begin;

create function app.normalize_source_key(p_source text) returns text
language sql immutable set search_path = '' as $$
  select nullif(lower(regexp_replace(btrim(coalesce(p_source, '')), '\s+', ' ', 'g')), '');
$$;
revoke all on function app.normalize_source_key(text) from public, anon, authenticated;

create table public.marketing_spend_entries (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('spend','reversal')),
  source_key text not null check (length(source_key) between 1 and 80),
  source_label text not null check (source_label = btrim(source_label) and length(source_label) between 1 and 80 and source_label !~ '[\x00-\x1f]'),
  spent_on date not null check (spent_on between date '2000-01-01' and date '2100-12-31'),
  amount numeric(14,2) not null check (amount > 0 and amount < 1000000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  note text check (note is null or (length(note) between 1 and 200 and note !~ '[\x00-\x08\x0b\x0c\x0e-\x1f]')),
  reversal_of uuid,
  request_key uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint uq_marketing_spend_org_id unique (organization_id, id),
  constraint uq_marketing_spend_request unique (organization_id, request_key),
  constraint fk_marketing_spend_reversal foreign key (organization_id, reversal_of) references public.marketing_spend_entries (organization_id, id),
  constraint chk_marketing_spend_reversal check ((kind = 'reversal') = (reversal_of is not null)),
  constraint chk_marketing_spend_reversal_note check (kind <> 'reversal' or note is not null),
  constraint chk_marketing_spend_key check (source_key = app.normalize_source_key(source_label))
);
create unique index uq_marketing_spend_reversal_of on public.marketing_spend_entries (organization_id, reversal_of) where reversal_of is not null;
create index idx_marketing_spend_period on public.marketing_spend_entries (organization_id, spent_on desc, id desc);

create function app.tg_marketing_spend_immutable() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'marketing spend entries are immutable; record a reversal instead' using errcode = 'restrict_violation'; end $$;
create trigger trg_marketing_spend_immutable before update or delete on public.marketing_spend_entries
  for each row execute function app.tg_marketing_spend_immutable();
create trigger trg_marketing_spend_audit after insert on public.marketing_spend_entries
  for each row execute function app.tg_write_audit();

alter table public.marketing_spend_entries enable row level security;
revoke all on public.marketing_spend_entries from public, anon, authenticated;
grant select on public.marketing_spend_entries to authenticated;
create policy marketing_spend_read on public.marketing_spend_entries for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()
         and app.has_module('finance') and app.has_permission('finance.read') and app.has_permission('branches.all')
         and not app.is_groomer_member()));

-- ---------------------------------------------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------------------------------------------
create function app.record_marketing_spend(
  p_source text, p_spent_on date, p_amount numeric, p_currency text, p_note text, p_request_key uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_label text := btrim(regexp_replace(btrim(coalesce(p_source, '')), '\s+', ' ', 'g'));
  v_key text := app.normalize_source_key(p_source);
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_existing public.marketing_spend_entries;
  v_id uuid;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.manage')
     or not app.has_permission('branches.all') or app.is_groomer_member() then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_request_key is null or v_key is null or length(v_label) not between 1 and 80 or v_label ~ '[\x00-\x1f]'
     or p_amount is null or p_amount <= 0 or p_amount >= 1000000000000 or p_amount <> round(p_amount, 2)
     or v_currency !~ '^[A-Z]{3}$'
     or p_spent_on is null or p_spent_on < date '2000-01-01' or p_spent_on > current_date + 1
     or (v_note is not null and (length(v_note) > 200 or v_note ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]')) then
    raise exception 'invalid_spend' using errcode = '22023'; end if;

  select s.* into v_existing from public.marketing_spend_entries s where s.organization_id = v_org and s.request_key = p_request_key;
  if found then
    if v_existing.kind = 'spend' and v_existing.source_key = v_key and v_existing.spent_on = p_spent_on
       and v_existing.amount = p_amount and v_existing.currency = v_currency then
      return v_existing.id; end if;
    raise exception 'request_conflict' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('marketing_spend:' || v_org::text, 0));
  if (select count(*) from public.marketing_spend_entries s where s.organization_id = v_org) >= 20000 then
    raise exception 'spend_limit_reached' using errcode = '22023'; end if;
  insert into public.marketing_spend_entries(organization_id, kind, source_key, source_label, spent_on, amount, currency, note, request_key, created_by)
  values (v_org, 'spend', v_key, v_label, p_spent_on, p_amount, v_currency, v_note, p_request_key, app.fn_current_user_id())
  returning id into v_id;
  return v_id;
end $$;

create function app.reverse_marketing_spend(p_entry uuid, p_reason text, p_request_key uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_orig public.marketing_spend_entries;
  v_existing public.marketing_spend_entries;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id uuid;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.manage')
     or not app.has_permission('branches.all') or app.is_groomer_member() then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_entry is null or p_request_key is null or v_reason is null or length(v_reason) not between 3 and 200
     or v_reason ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]' then
    raise exception 'invalid_reversal' using errcode = '22023'; end if;
  select s.* into v_orig from public.marketing_spend_entries s where s.organization_id = v_org and s.id = p_entry for update;
  if not found then raise exception 'entry_not_found' using errcode = 'P0002'; end if;

  select s.* into v_existing from public.marketing_spend_entries s where s.organization_id = v_org and s.request_key = p_request_key;
  if found then
    if v_existing.reversal_of = p_entry then return v_existing.id; end if;
    raise exception 'request_conflict' using errcode = '22023';
  end if;
  if v_orig.kind = 'reversal' then raise exception 'cannot_reverse_a_reversal' using errcode = '22023'; end if;
  if exists (select 1 from public.marketing_spend_entries r where r.organization_id = v_org and r.reversal_of = p_entry) then
    raise exception 'already_reversed' using errcode = '22023'; end if;

  -- The reversal keeps the original day so the period it corrects nets to zero.
  insert into public.marketing_spend_entries(organization_id, kind, source_key, source_label, spent_on, amount, currency, note, reversal_of, request_key, created_by)
  values (v_org, 'reversal', v_orig.source_key, v_orig.source_label, v_orig.spent_on, v_orig.amount, v_orig.currency, v_reason, v_orig.id, p_request_key, app.fn_current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Source return (read-only). Definer so the customer, payment and refund scans run once with the organization pinned.
-- ---------------------------------------------------------------------------------------------------------------
create function app.dashboard_source_roi(p_from date, p_to date, p_timezone text default 'Asia/Jakarta')
returns table (
  source_key text, source_label text, currency text,
  spend numeric, spend_entries integer, cohort_customers integer, paying_customers integer,
  collected numeric, refunded numeric, net_revenue numeric, net_result numeric, ratio numeric, has_spend boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_f timestamptz; v_t timestamptz;
begin
  if v_org is null or not app.has_membership()
     or not (app.has_permission('customer.read') or app.has_permission('customer.manage'))
     or not app.has_permission('finance.read') or not app.has_module('finance') or not app.has_module('crm')
     or not app.has_permission('branches.all') or app.is_groomer_member() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null then raise exception 'invalid_period' using errcode = '22023'; end if;
  perform app.dashboard_check_periods(p_from, p_to, p_from - 1 - (p_to - p_from), p_from - 1, p_timezone);
  v_f := p_from::timestamp at time zone p_timezone;
  v_t := (p_to + 1)::timestamp at time zone p_timezone;

  return query
  with spend as (
    select s.source_key, min(s.source_label) as label, s.currency,
           sum(case s.kind when 'spend' then s.amount else -s.amount end) as amount,
           count(*) filter (where s.kind = 'spend')::integer as entries
      from public.marketing_spend_entries s
     where s.organization_id = v_org and s.spent_on between p_from and p_to
     group by s.source_key, s.currency
  ), cohort as (
    select c.id as customer_id, app.normalize_source_key(c.source) as skey,
           left(nullif(regexp_replace(btrim(c.source), '\s+', ' ', 'g'), ''), 80) as sraw
      from public.customers c
     where c.organization_id = v_org and c.deleted_at is null and c.status <> 'archived'
       and c.created_at >= v_f and c.created_at < v_t and app.normalize_source_key(c.source) is not null
  ), pay as (
    select co.skey, p.currency, p.amount, co.customer_id
      from public.payments p
      left join public.invoices inv on inv.organization_id = p.organization_id and inv.id = p.invoice_id
      join cohort co on co.customer_id = coalesce(inv.customer_id, p.customer_id)
     where p.organization_id = v_org and p.status = 'succeeded' and p.paid_at >= v_f and p.paid_at < v_t
  ), ref as (
    select co.skey, p.currency, r.amount
      from public.refunds r
      join public.payments p on p.organization_id = r.organization_id and p.id = r.payment_id
      left join public.invoices inv on inv.organization_id = p.organization_id and inv.id = p.invoice_id
      join cohort co on co.customer_id = coalesce(inv.customer_id, p.customer_id)
     where r.organization_id = v_org and r.status = 'succeeded' and r.refunded_at >= v_f and r.refunded_at < v_t
  ), coh as (
    select co.skey, count(*)::integer as n, min(co.sraw) as label from cohort co group by co.skey
  ), payagg as (
    select pay.skey, pay.currency, sum(pay.amount) as collected, count(distinct pay.customer_id)::integer as payers
      from pay group by pay.skey, pay.currency
  ), refagg as (
    select ref.skey, ref.currency, sum(ref.amount) as refunded from ref group by ref.skey, ref.currency
  ), keys as (
    select spend.source_key as skey, spend.currency from spend
    union select payagg.skey, payagg.currency from payagg
    union select refagg.skey, refagg.currency from refagg
  ), rows_ as (
    select k.skey, k.currency,
           coalesce(sp.label, coh.label, k.skey) as label,
           coalesce(sp.amount, 0) as spend, coalesce(sp.entries, 0) as entries,
           coalesce(coh.n, 0) as n, coalesce(pa.payers, 0) as payers,
           coalesce(pa.collected, 0) as collected, coalesce(ra.refunded, 0) as refunded
      from keys k
      left join spend sp on sp.source_key = k.skey and sp.currency = k.currency
      left join coh on coh.skey = k.skey
      left join payagg pa on pa.skey = k.skey and pa.currency = k.currency
      left join refagg ra on ra.skey = k.skey and ra.currency = k.currency
  )
  select r.skey, r.label, r.currency, r.spend, r.entries, r.n, r.payers, r.collected, r.refunded,
         r.collected - r.refunded, (r.collected - r.refunded) - r.spend,
         case when r.spend > 0 then round((r.collected - r.refunded) / r.spend, 4) end,
         r.spend > 0
    from rows_ r
   -- a fully reversed spend (net zero) with no revenue is not a row worth showing
   where r.spend <> 0 or r.collected <> 0 or r.refunded <> 0 or r.entries > 0
   order by (r.spend > 0) desc, r.spend desc, r.collected desc, r.skey, r.currency
   limit 51;
end $$;

revoke all on function app.tg_marketing_spend_immutable() from public, anon, authenticated;
revoke all on function app.record_marketing_spend(text, date, numeric, text, text, uuid) from public, anon, authenticated;
revoke all on function app.reverse_marketing_spend(uuid, text, uuid) from public, anon, authenticated;
revoke all on function app.dashboard_source_roi(date, date, text) from public, anon, authenticated;
grant execute on function app.record_marketing_spend(text, date, numeric, text, text, uuid) to authenticated;
grant execute on function app.reverse_marketing_spend(uuid, text, uuid) to authenticated;
grant execute on function app.dashboard_source_roi(date, date, text) to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101100000'::text;
$$;

notify pgrst, 'reload schema';
commit;
