create schema if not exists onejournal_private;
revoke all on schema onejournal_private from public, anon, authenticated;
create table if not exists onejournal_private.game (
 id integer primary key check(id=1), revision bigint not null default 0, public_revision bigint not null default 0,
 state jsonb not null, hero_versions jsonb not null default '{}'::jsonb, selection text
);
create table if not exists onejournal_private.rolls (
 id text primary key, uid uuid not null, payload text not null, visibility text not null check(visibility in ('public','private')),
 entry jsonb not null, ordinal bigint not null
);
create table if not exists onejournal_private.access_links (
 id text primary key, role text not null check(role in ('gm','player')), hero_id text,
 secret_hash text not null unique, encrypted_secret text not null, version integer not null check(version>0), active boolean not null
);
create unique index if not exists onejournal_one_gm_link on onejournal_private.access_links(role) where role='gm';
create unique index if not exists onejournal_one_player_link_per_hero on onejournal_private.access_links(hero_id) where role='player';
create table if not exists onejournal_private.grants (
 uid uuid primary key, link_id text not null references onejournal_private.access_links(id), version integer not null,
 role text not null check(role in ('gm','player')), hero_id text, active boolean not null
);
create table if not exists public.onejournal_updates (id integer primary key check(id=1), revision bigint not null);
insert into onejournal_private.game(id,state) values (1,'{"version":2,"library":[],"battle":[],"heroes":[],"heroParticipants":[],"map":null}'::jsonb) on conflict(id) do nothing;
insert into public.onejournal_updates(id,revision) values (1,0) on conflict(id) do nothing;
alter table onejournal_private.game enable row level security;
alter table onejournal_private.rolls enable row level security;
alter table onejournal_private.access_links enable row level security;
alter table onejournal_private.grants enable row level security;
alter table public.onejournal_updates enable row level security;
revoke all on all tables in schema onejournal_private from public, anon, authenticated;
revoke all on public.onejournal_updates from public, anon, authenticated;
grant select on public.onejournal_updates to authenticated;
create or replace function onejournal_private.active_member(member_uid uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from onejournal_private.grants g join onejournal_private.access_links l on l.id=g.link_id
 where g.uid=member_uid and g.active and l.active and g.version=l.version and g.role=l.role
 and g.hero_id is not distinct from l.hero_id);
$$;
revoke all on function onejournal_private.active_member(uuid) from public, anon;
grant usage on schema onejournal_private to authenticated;
grant execute on function onejournal_private.active_member(uuid) to authenticated;
create policy onejournal_update_members on public.onejournal_updates for select to authenticated
 using(onejournal_private.active_member((select auth.uid())));
create or replace function public.onejournal_read()
returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('state',game.state,'revision',game.revision,'publicRevision',game.public_revision,
 'heroVersions',game.hero_versions,'selection',game.selection,
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
 state=document->'state',hero_versions=document->'heroVersions',selection=document->>'selection' where id=1;
 delete from onejournal_private.grants;
 delete from onejournal_private.access_links;
 insert into onejournal_private.access_links(id,role,hero_id,secret_hash,encrypted_secret,version,active)
 select x.id,x.role,x."heroId",x."secretHash",x."encryptedSecret",x.version,x.active
 from jsonb_to_recordset(document->'links') as x(id text,role text,"heroId" text,"secretHash" text,"encryptedSecret" text,version integer,active boolean);
 insert into onejournal_private.grants(uid,link_id,version,role,hero_id,active)
 select x.uid::uuid,x."linkId",x.version,x.role,x."heroId",x.active
 from jsonb_to_recordset(document->'grants') as x(uid text,"linkId" text,version integer,role text,"heroId" text,active boolean);
 delete from onejournal_private.rolls where id not in
   (select x.id from jsonb_to_recordset(document->'rolls') as x(id text));
 insert into onejournal_private.rolls(id,uid,payload,visibility,entry,ordinal)
 select x.value->>'id',(x.value->>'uid')::uuid,x.value->>'payload',x.value->>'visibility',x.value->'entry',x.n
 from jsonb_array_elements(document->'rolls') with ordinality as x(value,n)
 on conflict(id) do update set uid=excluded.uid,payload=excluded.payload,visibility=excluded.visibility,
 entry=excluded.entry,ordinal=excluded.ordinal;
 if notify_public then update public.onejournal_updates set revision=(document->>'publicRevision')::bigint where id=1; end if;
 return true;
end;
$$;
revoke all on function public.onejournal_cas(bigint,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.onejournal_cas(bigint,jsonb,boolean) to service_role;
do $$ begin alter publication supabase_realtime add table public.onejournal_updates;
exception when duplicate_object then null; end $$;
