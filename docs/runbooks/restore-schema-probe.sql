-- Restore-readiness schema probe. READ-ONLY: one SELECT, no writes.
--
-- Run it against the DISPOSABLE target database you intend to restore into (never production), passing the organization
-- id from the archive's manifest.json:
--
--   psql "$DISPOSABLE_DATABASE_URL" -v org=<organization uuid> -At -f docs/runbooks/restore-schema-probe.sql > probe.json
--
-- It describes the target's tenant tables (columns, NOT NULL columns without defaults, foreign keys, append-only triggers)
-- and how many rows the target already holds for that organization, in the format planRestoreReadiness() expects. It reads
-- no row content other than a COUNT per table.
select jsonb_build_object(
  'format', 'operro-restore-schema-probe',
  'version', 1,
  'schemaVersion', coalesce((select app.schema_version()), 'unknown'),
  'organizationId', :'org'::uuid,
  'tables', (
    select jsonb_object_agg(t.relname, jsonb_build_object(
      'columns', (select coalesce(jsonb_agg(a.attname order by a.attnum), '[]'::jsonb)
                    from pg_attribute a where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped),
      'required', (select coalesce(jsonb_agg(a.attname order by a.attnum), '[]'::jsonb)
                     from pg_attribute a
                     left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                    where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped and a.attnotnull
                      and d.adbin is null and a.attgenerated = '' and a.attidentity = ''),
      'foreignKeys', (select coalesce(jsonb_agg(jsonb_build_object(
                          'columns', (select jsonb_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum),
                          'refTable', rt.relname,
                          'refColumns', (select jsonb_agg(a.attname order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum))), '[]'::jsonb)
                        from pg_constraint c join pg_class rt on rt.oid = c.confrelid join pg_namespace rn on rn.oid = rt.relnamespace
                       where c.conrelid = t.oid and c.contype = 'f' and rn.nspname = 'public'),
      'insertOnly', exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                             where g.tgrelid = t.oid and not g.tgisinternal and p.proname ~ '(block_update|block_hard_delete|immutable|append_only)'),
      'existingRows', coalesce((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I where organization_id = %L', t.relname, :'org'), false, true, '')))[1]::text::bigint, 0)))
      from pg_class t join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relkind = 'r'
       and exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'organization_id' and not a.attisdropped))
);
