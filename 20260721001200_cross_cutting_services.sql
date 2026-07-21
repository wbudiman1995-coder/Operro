-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0008_financial_sales
-- Milestone        6A — Financial Domain (Sales & Receivables)
-- Purpose          The immutable record of commercial outcomes: a pure,
--                  deterministic Pricing resolver (ADR-002, Rule 30); the
--                  mutable Order working document; the IMMUTABLE Invoice +
--                  lines snapshot (Rule 29); immutable Payments and Refunds;
--                  an auto-populated, auditable Financial Ledger (Rule 24);
--                  and configurable Tax Rates.
-- Dependencies     0001, 0002, 0004 (customers/catalogs), 0005 (bookings),
--                  0007 (memberships for benefit resolution).
-- Objects Created  app.resolve_line_price(...)  -- pure resolver seed
--                  TABLES tax_rates, orders, order_items, invoices,
--                  invoice_lines, payments, refunds, financial_ledger
--                  FNS/triggers: order-total recompute, invoice immutability,
--                  ledger auto-population.
-- Constraints      COMPOSITE + TYPED FKs (ADR-002 §3.5, no polymorphism);
--                  issued invoices monetary-immutable; append-only ledger,
--                  payments, refunds, invoice_lines.
-- RLS Policies     RLS ENABLED (deny-all). Policies in M8. Module gating
--                  (M8): orders/invoices/payments -> 'finance' / 'pos'.
-- Breaking Changes None.
-- Rollback         DROP the 8 tables + resolver + fns (reverse dep order).
-- Notes            Resolvers DECIDE (pure); financial records PRESERVE the
--                  decision (snapshot). Historical invoices never recompute.
-- =====================================================================


-- =====================================================================
-- SECTION 001 — tax_rates (configurable catalog)
-- =====================================================================
create table public.tax_rates (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  name            text          not null,
  rate_percent    numeric(6,3)  not null default 0,
  is_active       boolean       not null default true,
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_tax_rates primary key (id),
  constraint fk_tax_rates_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint uq_tax_rates_org_id unique (organization_id, id),
  constraint chk_tax_rates_rate check (rate_percent >= 0)
);
create index idx_tax_rates_org on public.tax_rates (organization_id);
create trigger trg_tax_rates_updated_at before update on public.tax_rates for each row execute function app.tg_set_updated_at();
create trigger trg_tax_rates_audit_cols before insert or update on public.tax_rates for each row execute function app.tg_set_audit_columns();
create trigger trg_tax_rates_audit after insert or update or delete on public.tax_rates for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 002 — Pricing resolver (PURE / DETERMINISTIC — ADR-002, Rule 30)
-- =====================================================================
-- Decides a line price from base catalog price + best active membership
-- benefit. NO writes, no random, no hidden state. Callers snapshot the
-- returned decision; they never store a reference to be recomputed later.
create or replace function app.resolve_line_price(
  p_org uuid, p_customer uuid, p_item_type text, p_item_id uuid,
  p_quantity numeric, p_at timestamptz default now())
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare v_base numeric(14,2); v_disc numeric(6,3) := 0; v_src text := 'base';
        v_unit numeric(14,2); v_name text;
begin
  if p_item_type = 'service' then
    select base_price, name into v_base, v_name from public.service_catalog
     where organization_id = p_org and id = p_item_id;
  elsif p_item_type = 'product' then
    select selling_price, name into v_base, v_name from public.product_catalog
     where organization_id = p_org and id = p_item_id;
  end if;
  if v_base is null then return null; end if;

  -- best active-membership discount for this customer at p_at (policy set)
  select coalesce(max((mp.benefits->>'discount_percent')::numeric), 0)
    into v_disc
  from public.customer_memberships cm
  join public.membership_plans mp on mp.id = cm.membership_plan_id and mp.organization_id = cm.organization_id
  where cm.organization_id = p_org and cm.customer_id = p_customer and cm.status = 'active'
    and cm.started_at <= p_at
    and (cm.current_period_end is null or cm.current_period_end >= p_at);
  if v_disc > 0 then v_src := 'membership'; end if;

  v_unit := round(v_base * (1 - v_disc/100.0), 2);
  return jsonb_build_object(
    'item_name', v_name, 'base_unit', v_base, 'discount_percent', v_disc,
    'unit_price', v_unit, 'quantity', p_quantity,
    'line_total', round(v_unit * p_quantity, 2), 'source', v_src);
end; $$;


-- =====================================================================
-- SECTION 003 — orders + order_items (mutable working document)
-- =====================================================================
create table public.orders (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  branch_id       uuid          not null,
  customer_id     uuid,                                        -- nullable: anonymous walk-in
  booking_id      uuid,
  status          text          not null default 'draft',      -- draft|confirmed|fulfilled|canceled
  currency        text          not null default 'USD',
  subtotal        numeric(14,2)  not null default 0,
  discount_total  numeric(14,2)  not null default 0,
  tax_total       numeric(14,2)  not null default 0,
  total           numeric(14,2)  not null default 0,
  notes           text,
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_orders primary key (id),
  constraint fk_orders_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_orders_branches foreign key (organization_id, branch_id) references public.branches (organization_id, id),
  constraint fk_orders_customers foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  constraint fk_orders_bookings foreign key (organization_id, booking_id) references public.bookings (organization_id, id),
  constraint uq_orders_org_id unique (organization_id, id),
  constraint chk_orders_status check (status in ('draft','confirmed','fulfilled','canceled'))
);
create index idx_orders_org_branch on public.orders (organization_id, branch_id, status);
create trigger trg_orders_updated_at before update on public.orders for each row execute function app.tg_set_updated_at();
create trigger trg_orders_audit_cols before insert or update on public.orders for each row execute function app.tg_set_audit_columns();
create trigger trg_orders_audit after insert or update or delete on public.orders for each row execute function app.tg_write_audit();

create table public.order_items (
  id                uuid          not null default app.fn_uuid_v7(),
  organization_id   uuid          not null,
  order_id          uuid          not null,
  item_type         text          not null,                    -- service|product
  service_id        uuid,
  product_id        uuid,
  name_snapshot     text          not null,
  quantity          numeric(14,3)  not null default 1,
  unit_price        numeric(14,2)  not null default 0,          -- resolved & snapshotted
  discount_amount   numeric(14,2)  not null default 0,
  tax_rate_percent  numeric(6,3)   not null default 0,
  tax_amount        numeric(14,2)  not null default 0,
  line_total        numeric(14,2)  not null default 0,
  pricing_breakdown jsonb         not null default '{}'::jsonb, -- resolver decision snapshot
  metadata          jsonb         not null default '{}'::jsonb,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  created_by        uuid, updated_by uuid,
  constraint pk_order_items primary key (id),
  constraint fk_order_items_orders foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade,
  constraint fk_order_items_services foreign key (organization_id, service_id) references public.service_catalog (organization_id, id),
  constraint fk_order_items_products foreign key (organization_id, product_id) references public.product_catalog (organization_id, id),
  constraint chk_order_items_type check (item_type in ('service','product'))
);
create index idx_order_items_order on public.order_items (organization_id, order_id);
create trigger trg_order_items_updated_at before update on public.order_items for each row execute function app.tg_set_updated_at();
create trigger trg_order_items_audit_cols before insert or update on public.order_items for each row execute function app.tg_set_audit_columns();

-- Recompute order totals from its (mutable) items.
create or replace function public.tg_orders_recompute_totals()
returns trigger language plpgsql as $$
declare v_order uuid; v_org uuid;
begin
  v_order := coalesce(new.order_id, old.order_id);
  v_org   := coalesce(new.organization_id, old.organization_id);
  update public.orders o set
    subtotal       = t.sub, discount_total = t.disc, tax_total = t.tax,
    total          = t.sub - t.disc + t.tax, updated_at = now()
  from (
    select coalesce(sum(unit_price*quantity),0) sub,
           coalesce(sum(discount_amount),0) disc,
           coalesce(sum(tax_amount),0) tax
    from public.order_items where order_id = v_order and organization_id = v_org
  ) t
  where o.id = v_order and o.organization_id = v_org;
  return null;
end; $$;
create trigger trg_order_items_recompute after insert or update or delete on public.order_items
  for each row execute function public.tg_orders_recompute_totals();


-- =====================================================================
-- SECTION 004 — invoices + invoice_lines (IMMUTABLE snapshot — Rule 29)
-- =====================================================================
create table public.invoices (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  branch_id       uuid          not null,
  customer_id     uuid,
  order_id        uuid,
  invoice_number  text          not null,
  status          text          not null default 'issued',      -- issued|paid|void
  currency        text          not null default 'USD',
  subtotal        numeric(14,2)  not null,
  discount_total  numeric(14,2)  not null default 0,
  tax_total       numeric(14,2)  not null default 0,
  total           numeric(14,2)  not null,
  issued_at       timestamptz   not null default now(),
  due_at          timestamptz,
  paid_at         timestamptz,
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid,
  constraint pk_invoices primary key (id),
  constraint fk_invoices_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_invoices_branches foreign key (organization_id, branch_id) references public.branches (organization_id, id),
  constraint fk_invoices_customers foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  constraint fk_invoices_orders foreign key (organization_id, order_id) references public.orders (organization_id, id),
  constraint uq_invoices_org_id unique (organization_id, id),
  constraint uq_invoices_org_number unique (organization_id, invoice_number),
  constraint chk_invoices_status check (status in ('issued','paid','void'))
);
create index idx_invoices_org_customer on public.invoices (organization_id, customer_id);

-- Freeze monetary content once issued; only status / paid_at may change (Rule 29).
create or replace function public.tg_invoices_freeze()
returns trigger language plpgsql as $$
begin
  if (new.subtotal, new.discount_total, new.tax_total, new.total,
      new.currency, new.invoice_number, new.order_id) is distinct from
     (old.subtotal, old.discount_total, old.tax_total, old.total,
      old.currency, old.invoice_number, old.order_id) then
    raise exception 'Issued invoice % is immutable; monetary content cannot change (Rule 29).', old.invoice_number
      using errcode = 'restrict_violation';
  end if;
  return new;
end; $$;
create trigger trg_invoices_freeze before update on public.invoices for each row execute function public.tg_invoices_freeze();
create trigger trg_invoices_updated_at before update on public.invoices for each row execute function app.tg_set_updated_at();
create trigger trg_invoices_audit_cols before insert or update on public.invoices for each row execute function app.tg_set_audit_columns();
create trigger trg_invoices_audit after insert or update or delete on public.invoices for each row execute function app.tg_write_audit();

create table public.invoice_lines (
  id                uuid          not null default app.fn_uuid_v7(),
  organization_id   uuid          not null,
  invoice_id        uuid          not null,
  item_type         text          not null,
  name_snapshot     text          not null,
  quantity          numeric(14,3)  not null default 1,
  unit_price        numeric(14,2)  not null default 0,
  discount_amount   numeric(14,2)  not null default 0,
  tax_rate_percent  numeric(6,3)   not null default 0,
  tax_amount        numeric(14,2)  not null default 0,
  line_total        numeric(14,2)  not null default 0,
  pricing_breakdown jsonb         not null default '{}'::jsonb,
  created_at        timestamptz   not null default now(),
  created_by        uuid,
  constraint pk_invoice_lines primary key (id),
  constraint fk_invoice_lines_invoices foreign key (organization_id, invoice_id) references public.invoices (organization_id, id) on delete cascade,
  constraint chk_invoice_lines_type check (item_type in ('service','product'))
);
create index idx_invoice_lines_invoice on public.invoice_lines (organization_id, invoice_id);
-- Invoice lines are a frozen snapshot: append-only, no update/delete.
create trigger trg_invoice_lines_created_by before insert on public.invoice_lines for each row execute function app.tg_set_created_by();
create trigger trg_invoice_lines_block_update before update on public.invoice_lines for each row execute function app.tg_block_update();


-- =====================================================================
-- SECTION 005 — payments + refunds (immutable)
-- =====================================================================
create table public.payments (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  branch_id       uuid          not null,
  invoice_id      uuid,
  customer_id     uuid,
  method          text          not null,                      -- cash|card|wallet|bank_transfer|other
  amount          numeric(14,2)  not null,
  currency        text          not null default 'USD',
  status          text          not null default 'succeeded',  -- succeeded|pending|failed (set at insert)
  external_ref    text,
  paid_at         timestamptz   not null default now(),
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  created_by      uuid,
  constraint pk_payments primary key (id),
  constraint uq_payments_org_id unique (organization_id, id),
  constraint fk_payments_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_payments_branches foreign key (organization_id, branch_id) references public.branches (organization_id, id),
  constraint fk_payments_invoices foreign key (organization_id, invoice_id) references public.invoices (organization_id, id),
  constraint chk_payments_method check (method in ('cash','card','wallet','bank_transfer','other')),
  constraint chk_payments_status check (status in ('succeeded','pending','failed')),
  constraint chk_payments_amount check (amount > 0)
);
create index idx_payments_org_invoice on public.payments (organization_id, invoice_id);
create trigger trg_payments_created_by before insert on public.payments for each row execute function app.tg_set_created_by();
create trigger trg_payments_block_update before update on public.payments for each row execute function app.tg_block_update();
create trigger trg_payments_block_delete before delete on public.payments for each row execute function app.tg_block_hard_delete();

create table public.refunds (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  payment_id      uuid          not null,
  invoice_id      uuid,
  amount          numeric(14,2)  not null,
  reason          text,
  status          text          not null default 'succeeded',
  refunded_at     timestamptz   not null default now(),
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  created_by      uuid,
  constraint pk_refunds primary key (id),
  constraint fk_refunds_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_refunds_payments foreign key (organization_id, payment_id) references public.payments (organization_id, id),
  constraint chk_refunds_amount check (amount > 0)
);
create index idx_refunds_org_payment on public.refunds (organization_id, payment_id);
create trigger trg_refunds_created_by before insert on public.refunds for each row execute function app.tg_set_created_by();
create trigger trg_refunds_block_update before update on public.refunds for each row execute function app.tg_block_update();
create trigger trg_refunds_block_delete before delete on public.refunds for each row execute function app.tg_block_hard_delete();


-- =====================================================================
-- SECTION 006 — financial_ledger (immutable, auto-populated, TYPED FKs)
-- =====================================================================
create table public.financial_ledger (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  branch_id       uuid,
  entry_type      text          not null,                      -- invoice_issued|payment_received|refund_issued|invoice_void
  amount          numeric(14,2)  not null,                      -- SIGNED
  currency        text          not null default 'USD',
  invoice_id      uuid,                                         -- TYPED FKs (ADR-002 §3.5), not polymorphic
  payment_id      uuid,
  refund_id       uuid,
  occurred_at     timestamptz   not null default now(),
  created_at      timestamptz   not null default now(),
  created_by      uuid,
  constraint pk_financial_ledger primary key (id),
  constraint fk_financial_ledger_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_financial_ledger_invoices foreign key (organization_id, invoice_id) references public.invoices (organization_id, id),
  constraint fk_financial_ledger_payments foreign key (organization_id, payment_id) references public.payments (organization_id, id),
  constraint chk_financial_ledger_type check (entry_type in ('invoice_issued','payment_received','refund_issued','invoice_void'))
);
create index idx_financial_ledger_org_time on public.financial_ledger (organization_id, occurred_at);
create trigger trg_financial_ledger_created_by before insert on public.financial_ledger for each row execute function app.tg_set_created_by();
create trigger trg_financial_ledger_block_update before update on public.financial_ledger for each row execute function app.tg_block_update();
create trigger trg_financial_ledger_block_delete before delete on public.financial_ledger for each row execute function app.tg_block_hard_delete();

-- Auto-populate the ledger from financial events (Rule 26).
create or replace function public.tg_invoice_ledger()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.status = 'issued' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, invoice_id, occurred_at)
    values (new.organization_id, new.branch_id, 'invoice_issued', new.total, new.currency, new.id, new.issued_at);
  elsif tg_op = 'UPDATE' and new.status = 'void' and old.status <> 'void' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, invoice_id, occurred_at)
    values (new.organization_id, new.branch_id, 'invoice_void', -old.total, new.currency, new.id, now());
  end if;
  return null;
end; $$;
create trigger trg_invoices_ledger after insert or update of status on public.invoices
  for each row execute function public.tg_invoice_ledger();

create or replace function public.tg_payment_ledger()
returns trigger language plpgsql as $$
begin
  if new.status = 'succeeded' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, payment_id, occurred_at)
    values (new.organization_id, new.branch_id, 'payment_received', new.amount, new.currency, new.id, new.paid_at);
  end if;
  return null;
end; $$;
create trigger trg_payments_ledger after insert on public.payments
  for each row execute function public.tg_payment_ledger();

create or replace function public.tg_refund_ledger()
returns trigger language plpgsql as $$
begin
  if new.status = 'succeeded' then
    insert into public.financial_ledger (organization_id, entry_type, amount, refund_id, occurred_at)
    values (new.organization_id, 'refund_issued', -new.amount, new.id, new.refunded_at);
  end if;
  return null;
end; $$;
create trigger trg_refunds_ledger after insert on public.refunds
  for each row execute function public.tg_refund_ledger();


-- =====================================================================
-- SECTION 099 — Row Level Security (safety default: ENABLE, deny-all)
-- =====================================================================
alter table public.tax_rates        enable row level security;
alter table public.orders           enable row level security;
alter table public.order_items      enable row level security;
alter table public.invoices         enable row level security;
alter table public.invoice_lines    enable row level security;
alter table public.payments         enable row level security;
alter table public.refunds          enable row level security;
alter table public.financial_ledger enable row level security;

-- =====================================================================
-- END 0008_financial_sales
-- =====================================================================
