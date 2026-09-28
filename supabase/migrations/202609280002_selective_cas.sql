-- Explicit record reconciliation also works with Supabase safe-update guards.
create or replace function public.onejournal_cas(expected_revision bigint, document jsonb, notify_public boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_revision bigint;
begin
 select revision into current_revision from onejournal_private.game where id=1 for update;
 if current_revision is distinct from expected_revision then return false; end if;
 update onejournal_private.game set revision=(document->>'revision')::bigint,public_revision=(document->>'publicRevision')::bigint,
 state=document->'state',hero_versions=document->'heroVersions',selection=document->>'selection' where id=1;

 insert into onejournal_private.access_links(id,role,hero_id,secret_hash,encrypted_secret,version,active)
 select x.id,x.role,x."heroId",x."secretHash",x."encryptedSecret",x.version,x.active
 from jsonb_to_recordset(document->'links') as x(id text,role text,"heroId" text,"secretHash" text,"encryptedSecret" text,version integer,active boolean)
 on conflict(id) do update set role=excluded.role,hero_id=excluded.hero_id,secret_hash=excluded.secret_hash,
 encrypted_secret=excluded.encrypted_secret,version=excluded.version,active=excluded.active;

 delete from onejournal_private.grants g where not exists
 (select 1 from jsonb_array_elements(document->'grants') x where x->>'uid'=g.uid::text);
 insert into onejournal_private.grants(uid,link_id,version,role,hero_id,active)
 select x.uid::uuid,x."linkId",x.version,x.role,x."heroId",x.active
 from jsonb_to_recordset(document->'grants') as x(uid text,"linkId" text,version integer,role text,"heroId" text,active boolean)
 on conflict(uid) do update set link_id=excluded.link_id,version=excluded.version,role=excluded.role,hero_id=excluded.hero_id,active=excluded.active;
 delete from onejournal_private.access_links l where not exists
 (select 1 from jsonb_array_elements(document->'links') x where x->>'id'=l.id);

 delete from onejournal_private.rolls r where not exists
 (select 1 from jsonb_array_elements(document->'rolls') x where x->>'id'=r.id);
 insert into onejournal_private.rolls(id,uid,payload,visibility,entry,ordinal) overriding system value
 select x->>'id',(x->>'uid')::uuid,x->>'payload',x->>'visibility',x->'entry',n
 from jsonb_array_elements(document->'rolls') with ordinality as rows(x,n)
 on conflict(id) do update set uid=excluded.uid,payload=excluded.payload,visibility=excluded.visibility,entry=excluded.entry,ordinal=excluded.ordinal;
 if notify_public then update public.onejournal_updates set revision=(document->>'publicRevision')::bigint where id=1; end if;
 return true;
end;
$$;
revoke all on function public.onejournal_cas(bigint,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.onejournal_cas(bigint,jsonb,boolean) to service_role;
