-- Private, tenant-partitioned grooming evidence storage.
-- Object paths must begin with the active organization UUID. Metadata stays in the
-- existing public.attachments / attachment_links tables, linked to the booking.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 4194304, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy attachments_objects_read on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_membership()
  );

create policy attachments_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('booking.update')
  );

create policy attachments_objects_update on storage.objects for update to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('booking.update')
  )
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('booking.update')
  );

create policy attachments_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('booking.update')
  );
