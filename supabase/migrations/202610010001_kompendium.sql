create extension if not exists vector with schema extensions;

create table onejournal_private.kompendium_documents (
 id uuid primary key default gen_random_uuid(), title text not null check (length(title) between 1 and 200),
 storage_path text not null unique check (storage_path ~ '^[a-zA-Z0-9/_-]+\.pdf$'),
 pdf_pages integer not null check (pdf_pages between 1 and 10000), sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
 active boolean not null default false, activated_at timestamptz, created_at timestamptz not null default now()
);
create unique index kompendium_single_active on onejournal_private.kompendium_documents(active) where active;
create table onejournal_private.kompendium_chunks (
 id uuid primary key default gen_random_uuid(), document_id uuid not null references onejournal_private.kompendium_documents(id) on delete cascade,
 ordinal integer not null check (ordinal >= 0), content text not null check (length(content) between 1 and 8000),
 embedding_text text not null check (length(embedding_text) between 1 and 8000),
 pdf_page integer not null check (pdf_page > 0), book_page text check (length(book_page) <= 40),
 section text check (length(section) <= 300), embedding extensions.vector(1536) not null,
 search_tsv tsvector generated always as (to_tsvector('simple'::regconfig, content)) stored,
 unique(document_id, ordinal)
);
create index kompendium_chunks_document on onejournal_private.kompendium_chunks(document_id);
create index kompendium_chunks_tsv on onejournal_private.kompendium_chunks using gin(search_tsv);
create index kompendium_chunks_vector on onejournal_private.kompendium_chunks using hnsw(embedding extensions.vector_cosine_ops);
create table onejournal_private.kompendium_tickets (
 token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
 uid uuid not null, link_id text not null, link_version integer not null,
 document_id uuid not null references onejournal_private.kompendium_documents(id),
 pdf_page integer not null, expires_at timestamptz not null
);
create index kompendium_tickets_expiry on onejournal_private.kompendium_tickets(expires_at);
create table onejournal_private.kompendium_rate_events (
 id bigint generated always as identity primary key, uid uuid not null, occurred_at timestamptz not null default now()
);
create index kompendium_rate_uid_time on onejournal_private.kompendium_rate_events(uid, occurred_at);
create table onejournal_private.kompendium_usage (
 id uuid primary key, uid uuid, operation text not null check (operation in ('question','embedding','indexing')),
 question_id uuid, provider_request_id text, model text not null, created_at timestamptz not null default now(),
 input_tokens integer check (input_tokens >= 0), cached_input_tokens integer check (cached_input_tokens >= 0),
 output_tokens integer check (output_tokens >= 0), cost_usd numeric(16,9) check (cost_usd >= 0),
 incomplete boolean not null default true, error text, price_snapshot jsonb,
 check (cached_input_tokens is null or input_tokens is null or cached_input_tokens <= input_tokens),
 unique(provider_request_id)
);
create index kompendium_usage_uid_time on onejournal_private.kompendium_usage(uid, created_at);
alter table onejournal_private.kompendium_documents enable row level security;
alter table onejournal_private.kompendium_chunks enable row level security;
alter table onejournal_private.kompendium_tickets enable row level security;
alter table onejournal_private.kompendium_rate_events enable row level security;
alter table onejournal_private.kompendium_usage enable row level security;
revoke all on onejournal_private.kompendium_documents, onejournal_private.kompendium_chunks,
 onejournal_private.kompendium_tickets, onejournal_private.kompendium_rate_events,
 onejournal_private.kompendium_usage from public, anon, authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values ('onejournal-kompendium','onejournal-kompendium',false,104857600,array['application/pdf'])
 on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy kompendium_storage_server_only on storage.objects for all to service_role
 using(bucket_id='onejournal-kompendium') with check(bucket_id='onejournal-kompendium');
create policy kompendium_storage_client_deny on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id <> 'onejournal-kompendium') with check(bucket_id <> 'onejournal-kompendium');

create function onejournal_private.kompendium_is_gm(p_uid uuid) returns boolean
 language sql stable security definer set search_path='' as $$
 select exists(select 1 from onejournal_private.grants g
 join onejournal_private.access_links l on l.id=g.link_id
 where g.uid=p_uid and g.active and g.role='gm' and l.active and l.role='gm'
 and g.version=l.version and g.hero_id is not distinct from l.hero_id);
$$;
revoke all on function onejournal_private.kompendium_is_gm(uuid) from public,anon,authenticated;
create function public.kompendium_access(p_uid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select onejournal_private.kompendium_is_gm(p_uid);
$$;

create function public.kompendium_begin_import(p_title text,p_storage_path text,p_pdf_pages integer,p_sha256 text)
 returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 insert into onejournal_private.kompendium_documents(title,storage_path,pdf_pages,sha256)
 values(p_title,p_storage_path,p_pdf_pages,p_sha256) returning id into v_id;
 return v_id;
end $$;
create function public.kompendium_add_chunk(p_document_id uuid,p_ordinal integer,p_content text,p_embedding_text text,
 p_pdf_page integer,p_book_page text,p_section text,p_embedding extensions.vector(1536))
 returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from onejournal_private.kompendium_documents where id=p_document_id and activated_at is null
  and p_pdf_page between 1 and pdf_pages for update;
 if not found then
  raise exception 'Invalid staging document or PDF page';
 end if;
 insert into onejournal_private.kompendium_chunks(document_id,ordinal,content,embedding_text,pdf_page,book_page,section,embedding)
 values(p_document_id,p_ordinal,p_content,p_embedding_text,p_pdf_page,p_book_page,p_section,p_embedding);
end $$;
create function public.kompendium_activate_import(p_document_id uuid,p_expected_chunks integer)
 returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer; v_min integer; v_max integer;
begin
 perform pg_advisory_xact_lock(54892731);
 perform 1 from onejournal_private.kompendium_documents where id=p_document_id and activated_at is null for update;
 if not found then return false; end if;
 if not exists(select 1 from onejournal_private.kompendium_documents d join storage.objects o
  on o.bucket_id='onejournal-kompendium' and o.name=d.storage_path where d.id=p_document_id) then return false; end if;
 select count(*),min(ordinal),max(ordinal) into v_count,v_min,v_max from onejournal_private.kompendium_chunks where document_id=p_document_id;
 if p_expected_chunks is null or p_expected_chunks < 1 or v_count<>p_expected_chunks or v_min<>0 or v_max<>p_expected_chunks-1 then return false; end if;
 update onejournal_private.kompendium_documents set active=false where active;
 update onejournal_private.kompendium_documents set active=true,activated_at=now() where id=p_document_id;
 return true;
end $$;

create function public.kompendium_admit(p_uid uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
declare v_minute integer; v_hour integer;
begin
 if not onejournal_private.kompendium_is_gm(p_uid) then return false; end if;
 perform pg_advisory_xact_lock(hashtext(p_uid::text));
 delete from onejournal_private.kompendium_rate_events where occurred_at < now()-interval '1 day';
 select count(*) filter(where occurred_at > now()-interval '1 minute'),
 count(*) filter(where occurred_at > now()-interval '1 hour') into v_minute,v_hour
 from onejournal_private.kompendium_rate_events where uid=p_uid;
 if v_minute>=6 or v_hour>=30 then return false; end if;
 insert into onejournal_private.kompendium_rate_events(uid) values(p_uid);
 return true;
end $$;

create function public.kompendium_retrieve(p_uid uuid,p_query text,p_embedding extensions.vector(1536),p_prior_ids uuid[])
 returns table(chunk_id uuid,document_id uuid,content text,pdf_page integer,book_page text,section text)
 language plpgsql security definer set search_path='' as $$
begin
 if not onejournal_private.kompendium_is_gm(p_uid) then raise exception 'Forbidden'; end if;
 if length(p_query) < 1 or length(p_query)>2000 then raise exception 'Invalid query'; end if;
 return query
 with active_doc as (select id from onejournal_private.kompendium_documents where active),
 terms as (select string_agg(quote_literal(term),' | ') expression from unnest(tsvector_to_array(to_tsvector('simple'::regconfig,p_query))) term),
 semantic as (select c.id,row_number() over(order by c.embedding operator(extensions.<=>) p_embedding) as rank
   from onejournal_private.kompendium_chunks c join active_doc d on d.id=c.document_id
   order by c.embedding operator(extensions.<=>) p_embedding limit 24),
 literal as (select c.id,row_number() over(order by ts_rank_cd(c.search_tsv,to_tsquery('simple'::regconfig,t.expression)) desc) as rank
   from onejournal_private.kompendium_chunks c join active_doc d on d.id=c.document_id cross join terms t
   where t.expression is not null and c.search_tsv @@ to_tsquery('simple'::regconfig,t.expression)
   order by ts_rank_cd(c.search_tsv,to_tsquery('simple'::regconfig,t.expression)) desc limit 24),
 prior as (select c.id,row_number() over(order by c.ordinal desc) as rank
   from onejournal_private.kompendium_chunks c join active_doc d on d.id=c.document_id
   where c.id=any(coalesce(p_prior_ids,array[]::uuid[])) limit 6),
 ranked as (select coalesce(s.id,l.id) id,
 coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) score
 from semantic s full join literal l on l.id=s.id),
 combined as (select coalesce(r.id,p.id) id,coalesce(r.score,0)+coalesce(1.0/(60+p.rank),0) score
 from ranked r full join prior p on p.id=r.id),
 diverse as (select c.id,c.document_id,c.content,c.pdf_page,c.book_page,c.section,r.score,c.ordinal,
 row_number() over(partition by c.pdf_page order by r.score desc,c.ordinal) page_rank
 from combined r join onejournal_private.kompendium_chunks c on c.id=r.id)
 select d.id,d.document_id,d.content,d.pdf_page,d.book_page,d.section
 from diverse d order by d.page_rank,d.score desc,d.ordinal limit 6;
end $$;

create function public.kompendium_issue_ticket(p_uid uuid,p_document_id uuid,p_pdf_page integer,p_token_hash text)
 returns boolean language plpgsql security definer set search_path='' as $$
declare v_link_id text; v_version integer;
begin
 if not onejournal_private.kompendium_is_gm(p_uid) then return false; end if;
 select g.link_id,g.version into v_link_id,v_version from onejournal_private.grants g where g.uid=p_uid;
 if not exists(select 1 from onejournal_private.kompendium_chunks c join onejournal_private.kompendium_documents d on d.id=c.document_id
 where c.document_id=p_document_id and c.pdf_page=p_pdf_page and d.active) then return false; end if;
 insert into onejournal_private.kompendium_tickets(token_hash,uid,link_id,link_version,document_id,pdf_page,expires_at)
 values(p_token_hash,p_uid,v_link_id,v_version,p_document_id,p_pdf_page,now()+interval '60 seconds');
 return true;
end $$;
create function public.kompendium_redeem_ticket(p_token_hash text)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare v_ticket onejournal_private.kompendium_tickets%rowtype; v_doc onejournal_private.kompendium_documents%rowtype;
begin
 delete from onejournal_private.kompendium_tickets where token_hash=p_token_hash returning * into v_ticket;
 if not found or v_ticket.expires_at <= now() then return null; end if;
 if not onejournal_private.kompendium_is_gm(v_ticket.uid) then return null; end if;
 if not exists(select 1 from onejournal_private.grants g where g.uid=v_ticket.uid and g.link_id=v_ticket.link_id and g.version=v_ticket.link_version) then return null; end if;
 select * into v_doc from onejournal_private.kompendium_documents where id=v_ticket.document_id and active;
 if not found then return null; end if;
 return jsonb_build_object('storagePath',v_doc.storage_path,'pdfPage',v_ticket.pdf_page,'title',v_doc.title);
end $$;

create function public.kompendium_record_usage(p_id uuid,p_uid uuid,p_operation text,p_question_id uuid,p_provider_request_id text,
 p_model text,p_input_tokens integer,p_cached_input_tokens integer,p_output_tokens integer,p_cost_usd numeric,p_incomplete boolean,p_error text,p_price_snapshot jsonb)
 returns void language plpgsql security definer set search_path='' as $$
begin
 if p_provider_request_id is not null and exists(select 1 from onejournal_private.kompendium_usage where provider_request_id=p_provider_request_id and id<>p_id) then
  delete from onejournal_private.kompendium_usage where id=p_id and incomplete and provider_request_id is null;
  return;
 end if;
 insert into onejournal_private.kompendium_usage(id,uid,operation,question_id,provider_request_id,model,input_tokens,cached_input_tokens,output_tokens,cost_usd,incomplete,error,price_snapshot)
 values(p_id,p_uid,p_operation,p_question_id,p_provider_request_id,p_model,p_input_tokens,p_cached_input_tokens,p_output_tokens,p_cost_usd,p_incomplete,p_error,p_price_snapshot)
 on conflict(id) do update set provider_request_id=coalesce(excluded.provider_request_id,onejournal_private.kompendium_usage.provider_request_id),
 input_tokens=coalesce(onejournal_private.kompendium_usage.input_tokens,excluded.input_tokens),
 cached_input_tokens=coalesce(onejournal_private.kompendium_usage.cached_input_tokens,excluded.cached_input_tokens),
 output_tokens=coalesce(onejournal_private.kompendium_usage.output_tokens,excluded.output_tokens),
 cost_usd=coalesce(onejournal_private.kompendium_usage.cost_usd,excluded.cost_usd),
 incomplete=onejournal_private.kompendium_usage.incomplete and excluded.incomplete,
 error=case when onejournal_private.kompendium_usage.incomplete and excluded.incomplete then excluded.error else null end,
 price_snapshot=coalesce(onejournal_private.kompendium_usage.price_snapshot,excluded.price_snapshot);
end $$;
create function public.kompendium_usage_summary(p_uid uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare v_start timestamptz;
begin
 if not onejournal_private.kompendium_is_gm(p_uid) then raise exception 'Forbidden'; end if;
 v_start := date_trunc('month',now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw';
 return (select jsonb_build_object('month',
  jsonb_build_object('questions',count(distinct question_id) filter(where created_at>=v_start and operation='question'),
   'inputTokens',sum(input_tokens) filter(where created_at>=v_start),'cachedInputTokens',sum(cached_input_tokens) filter(where created_at>=v_start),
   'outputTokens',sum(output_tokens) filter(where created_at>=v_start),'costUsd',sum(cost_usd) filter(where created_at>=v_start),
   'indexingCostUsd',sum(cost_usd) filter(where created_at>=v_start and operation='indexing'),
   'conversationCostUsd',sum(cost_usd) filter(where created_at>=v_start and operation<>'indexing'),
   'incompleteRequests',count(*) filter(where created_at>=v_start and incomplete)),
  'allTime',jsonb_build_object('questions',count(distinct question_id) filter(where operation='question'),
   'inputTokens',sum(input_tokens),'cachedInputTokens',sum(cached_input_tokens),'outputTokens',sum(output_tokens),
   'costUsd',sum(cost_usd),'indexingCostUsd',sum(cost_usd) filter(where operation='indexing'),
   'conversationCostUsd',sum(cost_usd) filter(where operation<>'indexing'),'incompleteRequests',count(*) filter(where incomplete)))
 from onejournal_private.kompendium_usage);
end $$;

revoke all on function public.kompendium_begin_import(text,text,integer,text),
 public.kompendium_add_chunk(uuid,integer,text,text,integer,text,text,extensions.vector),
 public.kompendium_activate_import(uuid,integer),public.kompendium_admit(uuid),public.kompendium_access(uuid),
 public.kompendium_retrieve(uuid,text,extensions.vector,uuid[]),public.kompendium_issue_ticket(uuid,uuid,integer,text),
 public.kompendium_redeem_ticket(text),public.kompendium_record_usage(uuid,uuid,text,uuid,text,text,integer,integer,integer,numeric,boolean,text,jsonb),
 public.kompendium_usage_summary(uuid) from public,anon,authenticated;
grant execute on function public.kompendium_begin_import(text,text,integer,text),
 public.kompendium_add_chunk(uuid,integer,text,text,integer,text,text,extensions.vector),
 public.kompendium_activate_import(uuid,integer),public.kompendium_admit(uuid),public.kompendium_access(uuid),
 public.kompendium_retrieve(uuid,text,extensions.vector,uuid[]),public.kompendium_issue_ticket(uuid,uuid,integer,text),
 public.kompendium_redeem_ticket(text),public.kompendium_record_usage(uuid,uuid,text,uuid,text,text,integer,integer,integer,numeric,boolean,text,jsonb),
 public.kompendium_usage_summary(uuid) to service_role;
