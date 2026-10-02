-- Rank rare, accent-normalized query terms alongside vectors. Short stems cover
-- common Polish inflections and imperfect OCR without a handbook vocabulary.
create or replace function public.kompendium_retrieve(p_uid uuid,p_query text,p_embedding extensions.vector(1536),p_prior_ids uuid[])
 returns table(chunk_id uuid,document_id uuid,content text,pdf_page integer,book_page text,section text)
 language plpgsql security definer set search_path='' as $$
begin
 if not onejournal_private.kompendium_is_gm(p_uid) then raise exception 'Forbidden'; end if;
 if length(p_query) < 1 or length(p_query)>2000 then raise exception 'Invalid query'; end if;
 return query
 with active_chunks as materialized (
  select c.* from onejournal_private.kompendium_chunks c
  join onejournal_private.kompendium_documents d on d.id=c.document_id and d.active
 ), corpus as (select count(*)::numeric n from active_chunks),
 query_terms as materialized (
  select distinct case when length(word)>=7 then left(word,5) else word end stem
  from regexp_split_to_table(translate(lower(p_query),'ąćęłńóśźż','acelnoszz'),'[^a-z0-9]+') word
  where length(word)>=3
 ),
 chunk_terms as materialized (
  select c.id,t.stem from active_chunks c
  cross join lateral (
   select distinct case when length(word)>=7 then left(word,5) else word end stem
   from regexp_split_to_table(translate(lower(c.content),'ąćęłńóśźż','acelnoszz'),'[^a-z0-9]+') word
   where length(word)>=3
  ) t join query_terms q on q.stem=t.stem
 ),
 frequency as (select stem,count(*)::numeric df from chunk_terms group by stem),
 literal_scores as (
  select ct.id,sum(ln(1+corpus.n/f.df)) weight
  from chunk_terms ct join frequency f on f.stem=ct.stem cross join corpus
  where f.df<=greatest(1,corpus.n*0.2)
  group by ct.id
 ),
 semantic as (
  select c.id,row_number() over(order by c.embedding operator(extensions.<=>) p_embedding,c.ordinal) rank
  from active_chunks c order by c.embedding operator(extensions.<=>) p_embedding,c.ordinal limit 80
 ),
 literal as (
  select l.id,row_number() over(order by l.weight desc,c.ordinal) rank
  from literal_scores l join active_chunks c on c.id=l.id
  order by l.weight desc,c.ordinal limit 80
 ),
 prior as (
  select c.id,row_number() over(order by c.ordinal desc) rank
  from active_chunks c where c.id=any(coalesce(p_prior_ids,array[]::uuid[])) limit 6
 ),
 scored as (
  select c.id,c.document_id,c.content,c.pdf_page,c.book_page,c.section,c.ordinal,
   coalesce(1.0/(60+s.rank),0)+coalesce(1.5/(60+l.rank),0)+coalesce(1.0/(60+p.rank),0) score
  from active_chunks c left join semantic s on s.id=c.id
   left join literal l on l.id=c.id left join prior p on p.id=c.id
  where s.id is not null or l.id is not null or p.id is not null
 )
 select r.id,r.document_id,r.content,r.pdf_page,r.book_page,r.section
 from scored r order by r.score desc,r.ordinal limit 6;
end $$;
