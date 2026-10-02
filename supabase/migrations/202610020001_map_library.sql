-- Private image maps and thumbnails are read only through the Edge Function.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('onejournal-maps', 'onejournal-maps', false, 2097152, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg'];

create policy onejournal_map_server_only on storage.objects
as restrictive for all to anon, authenticated
using (bucket_id <> 'onejournal-maps')
with check (bucket_id <> 'onejournal-maps');
