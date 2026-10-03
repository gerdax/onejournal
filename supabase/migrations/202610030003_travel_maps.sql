-- Static travel maps and their manifest remain private; only service role reads them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('onejournal-travel-maps', 'onejournal-travel-maps', false, 20971520,
  array['image/jpeg', 'application/json'])
on conflict (id) do update set public = false, file_size_limit = 20971520,
  allowed_mime_types = array['image/jpeg', 'application/json'];

create policy onejournal_travel_map_server_only on storage.objects
as restrictive for all to anon, authenticated
using (bucket_id <> 'onejournal-travel-maps')
with check (bucket_id <> 'onejournal-travel-maps');
