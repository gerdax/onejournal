-- Avatar bytes are private Storage objects. Only the Edge Function service role
-- accesses them after checking the active Onejournal grant.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('onejournal-avatars', 'onejournal-avatars', false, 65536, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 65536,
  allowed_mime_types = array['image/jpeg'];

-- Restrictive policy also wins if this project has broad Storage policies.
create policy onejournal_avatar_server_only on storage.objects
as restrictive for all to anon, authenticated
using (bucket_id <> 'onejournal-avatars')
with check (bucket_id <> 'onejournal-avatars');
