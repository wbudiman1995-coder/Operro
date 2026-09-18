-- Private styling-reference photos linked to pets. Object access stays tenant
-- partitioned; metadata uses the existing attachments/attachment_links model.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('styling-references', 'styling-references', false, 4194304, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy styling_references_objects_read on storage.objects for select to authenticated
  using (
    bucket_id = 'styling-references'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_membership()
  );

create policy styling_references_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'styling-references'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('customer.manage')
  );

create policy styling_references_objects_update on storage.objects for update to authenticated
  using (
    bucket_id = 'styling-references'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('customer.manage')
  )
  with check (
    bucket_id = 'styling-references'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('customer.manage')
  );

create policy styling_references_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'styling-references'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('customer.manage')
  );

create index idx_attachments_styling_reference
  on public.attachments (organization_id, ((metadata->>'kind')), deleted_at)
  where storage_bucket = 'styling-references';

