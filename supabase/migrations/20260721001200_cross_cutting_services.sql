-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0012_cross_cutting_services
-- Milestone        7 — Cross-Cutting Platform Services
-- Purpose          Domain-agnostic services every domain consumes: file
--                  Attachments (+ links), an append-only Timeline, a
--                  Notification queue (+ templates), System Settings, and
--                  user Preferences. Uses a controlled generic subject
--                  reference (registry-checked) so new domains attach with
--                  ZERO schema change (ADR-002 §3.5 sanctioned exception).
-- Dependencies     0001–0011 (RLS helpers/policies, grants pattern).
-- Objects Created  subject_types (registry), attachments, attachment_links,
--                  timeline_events, notification_templates, notifications,
--                  system_settings, preferences (+ RLS policies).
-- Constraints      subject_type FK -> registry; subject_id untyped (generic);
--                  timeline & notifications observe, never decide (Rules 50/52).
-- RLS Policies     org isolation + membership (permissive); notifications
--                  gated by 'notifications' module (restrictive); catalogs
--                  read-all/admin-write; preferences own-only.
-- Breaking Changes None.
-- Rollback         DROP the 8 tables (reverse dep order).
-- Notes            These are SIDE-EFFECT / observability stores (Rule 51):
--                  written through business operations or system functions,
--                  never a source of business decisions.
-- =====================================================================


-- =====================================================================
-- SECTION 001 — subject_types registry (adding a domain = a data row)
-- =====================================================================
create table public.subject_types (
  key         text not null,
  description text,
  constraint pk_subject_types primary key (key)
);
insert into public.subject_types (key, description) values
  ('booking','Booking'),('customer','Customer'),('pet','Pet'),('invoice','Invoice'),
  ('payment','Payment'),('refund','Refund'),('order','Order'),('membership','Customer membership'),
  ('package','Customer package'),('payroll_run','Payroll run'),('expense','Expense'),
  ('resource','Resource'),('product','Product'),('service','Service'),('commission','Commission');


-- =====================================================================
-- SECTION 002 — attachments (core file) + links (typed FK to file)
-- =====================================================================
create table public.attachments (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  storage_bucket  text        not null default 'attachments',
  storage_path    text        not null,
  filename        text        not null,
  mime_type       text,
  size_bytes      bigint,
  uploaded_by     uuid,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_attachments primary key (id),
  constraint fk_attachments_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint uq_attachments_org_id unique (organization_id, id)
);
create index idx_attachments_org on public.attachments (organization_id);
create trigger trg_attachments_updated_at before update on public.attachments for each row execute function app.tg_set_updated_at();
create trigger trg_attachments_audit_cols before insert or update on public.attachments for each row execute function app.tg_set_audit_columns();
create trigger trg_attachments_audit after insert or update or delete on public.attachments for each row execute function app.tg_write_audit();

create table public.attachment_links (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  attachment_id   uuid        not null,
  subject_type    text        not null,            -- registry-checked
  subject_id      uuid        not null,            -- generic (ADR-002 §3.5 exception)
  created_at      timestamptz not null default now(),
  created_by      uuid,
  constraint pk_attachment_links primary key (id),
  constraint fk_attachment_links_attachments foreign key (organization_id, attachment_id)
    references public.attachments (organization_id, id) on delete cascade,
  constraint fk_attachment_links_subject_type foreign key (subject_type)
    references public.subject_types (key),
  constraint uq_attachment_links unique (attachment_id, subject_type, subject_id)
);
create index idx_attachment_links_subject on public.attachment_links (organization_id, subject_type, subject_id);
create trigger trg_attachment_links_created_by before insert on public.attachment_links for each row execute function app.tg_set_created_by();


-- =====================================================================
-- SECTION 003 — timeline_events (append-only observability; Rules 50/52)
-- =====================================================================
create table public.timeline_events (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  subject_type    text        not null,
  subject_id      uuid        not null,
  actor_id        uuid,
  event_type      text        not null,
  summary         text,
  data            jsonb       not null default '{}'::jsonb,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  created_by      uuid,
  constraint pk_timeline_events primary key (id),
  constraint fk_timeline_events_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_timeline_events_subject_type foreign key (subject_type) references public.subject_types (key)
);
create index idx_timeline_events_subject on public.timeline_events (organization_id, subject_type, subject_id, occurred_at);
create trigger trg_timeline_events_created_by before insert on public.timeline_events for each row execute function app.tg_set_created_by();
create trigger trg_timeline_events_block_update before update on public.timeline_events for each row execute function app.tg_block_update();
create trigger trg_timeline_events_block_delete before delete on public.timeline_events for each row execute function app.tg_block_hard_delete();


-- =====================================================================
-- SECTION 004 — notifications (queue) + templates
-- =====================================================================
create table public.notification_templates (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  key             text        not null,
  channel         text        not null,            -- email|sms|push|whatsapp|webhook
  subject         text,
  body            text,
  is_active       boolean     not null default true,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_notification_templates primary key (id),
  constraint fk_notification_templates_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint uq_notification_templates unique (organization_id, key, channel),
  constraint chk_notification_templates_channel check (channel in ('email','sms','push','whatsapp','webhook'))
);
create index idx_notification_templates_org on public.notification_templates (organization_id);
create trigger trg_notification_templates_updated_at before update on public.notification_templates for each row execute function app.tg_set_updated_at();
create trigger trg_notification_templates_audit_cols before insert or update on public.notification_templates for each row execute function app.tg_set_audit_columns();
create trigger trg_notification_templates_audit after insert or update or delete on public.notification_templates for each row execute function app.tg_write_audit();

create table public.notifications (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  channel         text        not null,
  template_key    text,
  recipient       jsonb       not null default '{}'::jsonb,   -- {email|phone|customer_id|user_id}
  subject_type    text,
  subject_id      uuid,
  payload         jsonb       not null default '{}'::jsonb,
  status          text        not null default 'queued',      -- queued|sent|failed|canceled
  scheduled_at    timestamptz not null default now(),
  sent_at         timestamptz,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid,
  constraint pk_notifications primary key (id),
  constraint fk_notifications_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_notifications_subject_type foreign key (subject_type) references public.subject_types (key),
  constraint chk_notifications_channel check (channel in ('email','sms','push','whatsapp','webhook')),
  constraint chk_notifications_status check (status in ('queued','sent','failed','canceled'))
);
create index idx_notifications_org_status on public.notifications (organization_id, status, scheduled_at);
create trigger trg_notifications_updated_at before update on public.notifications for each row execute function app.tg_set_updated_at();
create trigger trg_notifications_audit_cols before insert or update on public.notifications for each row execute function app.tg_set_audit_columns();


-- =====================================================================
-- SECTION 005 — system_settings (global) + preferences (per user)
-- =====================================================================
create table public.system_settings (
  key         text        not null,
  value       jsonb       not null default '{}'::jsonb,
  description text,
  updated_at  timestamptz not null default now(),
  constraint pk_system_settings primary key (key)
);
-- NOTE: organization- and branch-scoped settings live in the existing
-- organizations.settings / branches.settings JSONB columns (no duplication).

create table public.preferences (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  user_id         uuid        not null,
  key             text        not null,
  value           jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint pk_preferences primary key (id),
  constraint fk_preferences_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_preferences_users foreign key (user_id) references public.users (id) on delete cascade,
  constraint uq_preferences unique (organization_id, user_id, key)
);
create index idx_preferences_user on public.preferences (organization_id, user_id);
create trigger trg_preferences_updated_at before update on public.preferences for each row execute function app.tg_set_updated_at();


-- =====================================================================
-- SECTION 006 — Grants (new tables) + RLS enable
-- =====================================================================
grant select, insert, update, delete on all tables in schema public to authenticated;

alter table public.subject_types          enable row level security;
alter table public.attachments            enable row level security;
alter table public.attachment_links       enable row level security;
alter table public.timeline_events        enable row level security;
alter table public.notification_templates enable row level security;
alter table public.notifications          enable row level security;
alter table public.system_settings        enable row level security;
alter table public.preferences            enable row level security;


-- =====================================================================
-- SECTION 007 — Policies
-- =====================================================================
-- registry: read-all authenticated; write platform admin
create policy subject_types_read on public.subject_types for select using (true);
create policy subject_types_admin on public.subject_types for all using (app.is_platform_admin()) with check (app.is_platform_admin());

-- system settings: platform admin only
create policy system_settings_admin on public.system_settings for all using (app.is_platform_admin()) with check (app.is_platform_admin());

-- org-isolation + membership (permissive) for cross-cutting tenant tables
do $$
declare t text;
begin
  foreach t in array array['attachments','attachment_links','timeline_events','notification_templates','notifications']
  loop
    execute format($f$
      create policy %1$s_org_isolation on public.%1$s for all
      using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()))
      with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()));
    $f$, t);
  end loop;
end $$;

-- notifications + templates additionally gated by the 'notifications' module (restrictive)
create policy notifications_module_gate on public.notifications as restrictive for all
  using (app.is_platform_admin() or app.has_module('notifications'))
  with check (app.is_platform_admin() or app.has_module('notifications'));
create policy notification_templates_module_gate on public.notification_templates as restrictive for all
  using (app.is_platform_admin() or app.has_module('notifications'))
  with check (app.is_platform_admin() or app.has_module('notifications'));

-- preferences: a user manages only their own, within the active org
create policy preferences_own on public.preferences for all
  using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and user_id = app.fn_current_user_id()))
  with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and user_id = app.fn_current_user_id()));

-- =====================================================================
-- END 0012_cross_cutting_services
-- =====================================================================
