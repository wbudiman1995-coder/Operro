-- Tenant-scoped read API for the immutable audit trail.
-- app.audit_log remains private; authenticated callers can only read rows for
-- their active organization through this bounded SECURITY DEFINER function.

create or replace function app.list_audit_events(
  p_entity_table text,
  p_entity_id uuid,
  p_limit integer default 20
)
returns table (
  id uuid,
  organization_id uuid,
  actor_id uuid,
  action text,
  entity_table text,
  entity_id uuid,
  diff jsonb,
  occurred_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    audit.id,
    audit.organization_id,
    audit.actor_id,
    audit.action,
    audit.entity_table,
    audit.entity_id,
    audit.diff,
    audit.occurred_at
  from app.audit_log as audit
  where app.has_membership()
    and audit.organization_id = app.fn_active_organization()
    and audit.entity_table = p_entity_table
    and audit.entity_id = p_entity_id
  order by audit.occurred_at desc, audit.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;

comment on function app.list_audit_events(text, uuid, integer) is
  'Returns up to 100 audit events for one entity in the caller active organization.';

revoke all on function app.list_audit_events(text, uuid, integer) from public;
grant execute on function app.list_audit_events(text, uuid, integer) to authenticated;
