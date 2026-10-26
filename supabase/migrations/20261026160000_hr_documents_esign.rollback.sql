-- Rollback for 20261026160000_hr_documents_esign.sql. NOT a migration: run by hand
-- only if the module is abandoned BEFORE any real document was assigned.
-- If real records exist, do not run this; disable the admin tab instead.
begin;
do $$ begin
  if exists (select 1 from public.hr_assignments) then
    raise exception 'hr_assignments has rows; refusing to drop HR records.';
  end if;
end $$;
drop table if exists public.hr_audit, public.hr_signatures, public.hr_assignments,
  public.hr_document_versions, public.hr_documents, public.hr_role_scopes, public.hr_employees cascade;
drop function if exists public.hr_lock_completed_assignment(), public.hr_block_update(), public.hr_block_delete();
-- After rollback also remove the edge-function secrets: supabase secrets unset HR_DOB_HMAC_KEY HR_SIGNING_SECRET
-- (hr_employees.dob_hmac goes away with the table; no date of birth was ever stored.)
-- The empty bucket can be removed in the dashboard (Storage > hr-documents) if desired.
commit;
