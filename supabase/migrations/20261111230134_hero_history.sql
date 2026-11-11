-- Additive only: never normalize, rewrite, or replace existing gameplay data.
-- The migration runner executes this file in one transaction. Block concurrent
-- game writes until both the baseline and the trigger exist; fail rather than wait.
set local lock_timeout = '5s';
lock table onejournal_private.game in share row exclusive mode;
create temporary table hero_history_deployment_guard on commit drop as
 select to_jsonb(g) as original from onejournal_private.game g;

create table onejournal_private.hero_history (
 id bigint generated always as identity primary key,
 hero_id text not null,
 recorded_at timestamptz not null default clock_timestamp(),
 operation text not null check (operation in ('baseline','insert','update','delete')),
 game_revision bigint not null,
 hero_version bigint,
 hero jsonb,
 previous_hero jsonb,
 check (hero is not null or previous_hero is not null)
);
create index hero_history_hero_id_id on onejournal_private.hero_history(hero_id,id desc);
alter table onejournal_private.hero_history enable row level security;
revoke all on onejournal_private.hero_history from public,anon,authenticated,service_role;
revoke all on sequence onejournal_private.hero_history_id_seq from public,anon,authenticated,service_role;
grant usage on schema onejournal_private to service_role;
grant select on onejournal_private.hero_history to service_role;

insert into onejournal_private.hero_history(hero_id,operation,game_revision,hero_version,hero)
 select h->>'id','baseline',g.revision,(g.hero_versions->>(h->>'id'))::bigint,h
 from onejournal_private.game g cross join lateral jsonb_array_elements(g.state->'heroes') h;

create function onejournal_private.capture_hero_history()
returns trigger language plpgsql security invoker set search_path='' as $$
declare old_heroes jsonb := '[]'; new_heroes jsonb := '[]'; versions jsonb; revision bigint;
begin
 if TG_OP = 'TRUNCATE' then
   raise exception 'Truncating game would bypass character history';
 end if;
 if TG_OP <> 'INSERT' then old_heroes := coalesce(OLD.state->'heroes','[]'); end if;
 if TG_OP <> 'DELETE' then
   new_heroes := coalesce(NEW.state->'heroes','[]');
   versions := NEW.hero_versions; revision := NEW.revision;
 else
   versions := OLD.hero_versions; revision := OLD.revision;
 end if;
 if old_heroes = new_heroes then return null; end if;
 insert into onejournal_private.hero_history(hero_id,operation,game_revision,hero_version,hero,previous_hero)
 select coalesce(n.h->>'id',o.h->>'id'),
   case when n.h is null then 'delete' when o.h is null then 'insert' else 'update' end,
   revision,(versions->>coalesce(n.h->>'id',o.h->>'id'))::bigint,n.h,o.h
 from jsonb_array_elements(old_heroes) o(h)
 full join jsonb_array_elements(new_heroes) n(h) on o.h->>'id'=n.h->>'id'
 where o.h is distinct from n.h;
 return null;
end;
$$;
revoke all on function onejournal_private.capture_hero_history() from public,anon,authenticated,service_role;
create trigger capture_hero_history after insert or update or delete on onejournal_private.game
 for each row execute function onejournal_private.capture_hero_history();
create trigger prevent_game_truncate before truncate on onejournal_private.game
 for each statement execute function onejournal_private.capture_hero_history();

-- Read through the Edge Function after its GM grant check. No client access,
-- no definer privileges, no modification or pruning API. IDs are strings for JS.
create function public.onejournal_hero_history(hero_id text)
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',h.id::text,'heroId',h.hero_id,'recordedAt',h.recorded_at,
   'operation',h.operation,'gameRevision',h.game_revision,'heroVersion',h.hero_version,
   'hero',h.hero,'previousHero',h.previous_hero) order by h.id desc),'[]'::jsonb)
 from (select * from onejournal_private.hero_history h
       where h.hero_id=onejournal_hero_history.hero_id order by h.id desc limit 100) h;
$$;
revoke all on function public.onejournal_hero_history(text) from public,anon,authenticated;
grant execute on function public.onejournal_hero_history(text) to service_role;

-- Verify preservation while the write lock is still held. A mismatch aborts
-- the entire migration, including table/trigger creation and the baseline.
do $$ begin
 if exists (
   (select original from hero_history_deployment_guard except all select to_jsonb(g) from onejournal_private.game g)
   union all
   (select to_jsonb(g) from onejournal_private.game g except all select original from hero_history_deployment_guard)
 ) then raise exception 'Game changed during history installation'; end if;
end $$;
