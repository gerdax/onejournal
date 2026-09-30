-- GM notes remain in the private game row and have their own optimistic version.
-- Existing callers omit notebook fields, so their gameplay CAS preserves notes.
alter table onejournal_private.game
 add column if not exists notebook jsonb not null default '{"blocks":[]}'::jsonb,
 add column if not exists notebook_version bigint not null default 0;

create or replace function public.onejournal_read()
returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('state',game.state,'revision',game.revision,'publicRevision',game.public_revision,
 'heroVersions',game.hero_versions,'selection',game.selection,
 'notebook',game.notebook,'notebookVersion',game.notebook_version,
 'rolls',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'uid',r.uid,'payload',r.payload,'visibility',r.visibility,'entry',r.entry) order by r.ordinal) from onejournal_private.rolls r),'[]'::jsonb),
 'links',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'role',l.role,'heroId',l.hero_id,'secretHash',l.secret_hash,'encryptedSecret',l.encrypted_secret,'version',l.version,'active',l.active)) from onejournal_private.access_links l),'[]'::jsonb),
 'grants',coalesce((select jsonb_agg(jsonb_build_object('uid',g.uid,'linkId',g.link_id,'version',g.version,'role',g.role,'heroId',g.hero_id,'active',g.active)) from onejournal_private.grants g),'[]'::jsonb))
 from onejournal_private.game game where game.id=1;
$$;
revoke all on function public.onejournal_read() from public, anon, authenticated;
grant execute on function public.onejournal_read() to service_role;

create or replace function public.onejournal_cas(expected_revision bigint, document jsonb, notify_public boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_revision bigint;
begin
 select revision into current_revision from onejournal_private.game where id=1 for update;
 if current_revision is distinct from expected_revision then return false; end if;
 update onejournal_private.game set revision=(document->>'revision')::bigint,public_revision=(document->>'publicRevision')::bigint,
 state=document->'state',hero_versions=document->'heroVersions',selection=document->>'selection',
 notebook=coalesce(document->'notebook',notebook),
 notebook_version=coalesce((document->>'notebookVersion')::bigint,notebook_version) where id=1;

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
