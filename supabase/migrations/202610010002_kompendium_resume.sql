-- Administrative resume is available only to the service role. A staged document
-- remains immutable after activation, including on repeated requests.
alter table onejournal_private.kompendium_documents
 add column import_lease_token uuid, add column import_lease_until timestamptz;

create function public.kompendium_claim_import(p_document_id uuid,p_token uuid)
 returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_token is null then return false; end if;
 update onejournal_private.kompendium_documents
 set import_lease_token=p_token,import_lease_until=now()+interval '5 minutes'
 where id=p_document_id and activated_at is null
  and (import_lease_token=p_token or import_lease_until is null or import_lease_until<now());
 return found;
end $$;

create function public.kompendium_release_import(p_document_id uuid,p_token uuid)
 returns void language plpgsql security definer set search_path='' as $$
begin
 update onejournal_private.kompendium_documents set import_lease_token=null,import_lease_until=null
 where id=p_document_id and import_lease_token=p_token;
end $$;

create or replace function public.kompendium_resume_import(p_title text,p_pdf_pages integer,p_sha256 text)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare v_doc onejournal_private.kompendium_documents%rowtype;
begin
 select * into v_doc from onejournal_private.kompendium_documents
 where title=p_title and pdf_pages=p_pdf_pages and sha256=p_sha256 and activated_at is null
 order by created_at desc,id desc limit 1;
 if not found then return null; end if;
 return jsonb_build_object('documentId',v_doc.id,'storagePath',v_doc.storage_path,
  'pdfUploaded',exists(select 1 from storage.objects where bucket_id='onejournal-kompendium' and name=v_doc.storage_path),
  'chunks',coalesce((select jsonb_agg(jsonb_build_object('ordinal',ordinal,'content',content,
   'embeddingText',embedding_text,'pdfPage',pdf_page,'bookPage',book_page,'section',section) order by ordinal)
   from onejournal_private.kompendium_chunks where document_id=v_doc.id),'[]'::jsonb));
end $$;

-- A lost activation response can be retried without reporting a false failure.
create or replace function public.kompendium_activate_import(p_document_id uuid,p_expected_chunks integer)
 returns boolean language plpgsql security definer set search_path='' as $$
declare v_doc onejournal_private.kompendium_documents%rowtype; v_count integer; v_min integer; v_max integer;
begin
 perform pg_advisory_xact_lock(54892731);
 select * into v_doc from onejournal_private.kompendium_documents where id=p_document_id for update;
 if not found then return false; end if;
 select count(*),min(ordinal),max(ordinal) into v_count,v_min,v_max
  from onejournal_private.kompendium_chunks where document_id=p_document_id;
 if p_expected_chunks is null or p_expected_chunks < 1 or v_count<>p_expected_chunks
  or v_min<>0 or v_max<>p_expected_chunks-1 then return false; end if;
 if v_doc.activated_at is not null then return v_doc.active; end if;
 if not exists(select 1 from storage.objects where bucket_id='onejournal-kompendium' and name=v_doc.storage_path) then return false; end if;
 update onejournal_private.kompendium_documents set active=false where active;
 update onejournal_private.kompendium_documents set active=true,activated_at=now() where id=p_document_id;
 return true;
end $$;

create or replace function public.kompendium_add_chunk(p_document_id uuid,p_ordinal integer,p_content text,p_embedding_text text,
 p_pdf_page integer,p_book_page text,p_section text,p_embedding extensions.vector(1536))
 returns void language plpgsql security definer set search_path='' as $$
declare v_existing onejournal_private.kompendium_chunks%rowtype;
begin
 perform 1 from onejournal_private.kompendium_documents where id=p_document_id and activated_at is null
  and p_pdf_page between 1 and pdf_pages for update;
 if not found then raise exception 'Invalid staging document or PDF page'; end if;
 select * into v_existing from onejournal_private.kompendium_chunks
  where document_id=p_document_id and ordinal=p_ordinal;
 if found then
  if v_existing.content is distinct from p_content or v_existing.embedding_text is distinct from p_embedding_text
   or v_existing.pdf_page is distinct from p_pdf_page or v_existing.book_page is distinct from p_book_page
   or v_existing.section is distinct from p_section or v_existing.embedding::text is distinct from p_embedding::text then
   raise exception 'Conflicting chunk payload for ordinal %',p_ordinal;
  end if;
  return;
 end if;
 insert into onejournal_private.kompendium_chunks(document_id,ordinal,content,embedding_text,pdf_page,book_page,section,embedding)
 values(p_document_id,p_ordinal,p_content,p_embedding_text,p_pdf_page,p_book_page,p_section,p_embedding);
end $$;

revoke all on function public.kompendium_resume_import(text,integer,text) from public,anon,authenticated;
grant execute on function public.kompendium_resume_import(text,integer,text) to service_role;
revoke all on function public.kompendium_claim_import(uuid,uuid),public.kompendium_release_import(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.kompendium_claim_import(uuid,uuid),public.kompendium_release_import(uuid,uuid)
 to service_role;
