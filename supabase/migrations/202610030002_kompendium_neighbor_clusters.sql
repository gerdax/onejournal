-- Prefer contiguous clusters of relevant anchors over isolated hits when expanding context.
create or replace function public.kompendium_neighbors(p_uid uuid,p_ids uuid[])
 returns table(chunk_id uuid,document_id uuid,content text,pdf_page integer,book_page text,section text)
 language plpgsql security definer set search_path='' as $$
begin
 if not onejournal_private.kompendium_is_gm(p_uid) then raise exception 'Forbidden'; end if;
 if coalesce(cardinality(p_ids),0)>6 then raise exception 'Too many anchors'; end if;
 return query
 with anchors as (
  select c.* from onejournal_private.kompendium_chunks c
  join onejournal_private.kompendium_documents d on d.id=c.document_id and d.active
  where c.id=any(coalesce(p_ids,array[]::uuid[]))
 ), candidates as (
  select c.id,min(abs(c.ordinal-a.ordinal)) distance
  from anchors a join onejournal_private.kompendium_chunks c
   on c.document_id=a.document_id and abs(c.ordinal-a.ordinal)<=2
  where not(c.id=any(coalesce(p_ids,array[]::uuid[])))
  group by c.id
 )
 select c.id,c.document_id,c.content,c.pdf_page,c.book_page,c.section
 from candidates n join onejournal_private.kompendium_chunks c on c.id=n.id
 order by (select count(*) from anchors a where a.document_id=c.document_id and abs(a.ordinal-c.ordinal)<=12) desc,n.distance,c.ordinal limit 12;
end $$;
revoke all on function public.kompendium_neighbors(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.kompendium_neighbors(uuid,uuid[]) to service_role;
