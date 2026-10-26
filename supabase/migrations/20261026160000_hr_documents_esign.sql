-- ============================================================================
-- The Quarry: employee personnel documents with e-signature (hr-docs)
-- Project: nkulhtalltbieicvmmad (THE QUARRY ONLY)
--
-- STATUS: FILE ONLY. Not applied to the live database. Apply only with Matt's OK.
--
-- Design (see docs/SCOPE-hr-docs.md):
--   * Every table has RLS ON with NO policies and all grants revoked from
--     anon/authenticated. Only the service role (the hr-docs edge function)
--     can read or write. Role checks (owner/admin vs manager scope) live in
--     the function, the same pattern as employee_writeups / staff_evaluations.
--   * Nothing is ever hard-deleted: a trigger blocks DELETE on every table.
--     Records are voided (voided_at + void_reason) instead.
--   * Document versions, signatures and the audit trail are append-only:
--     UPDATE is blocked too.
--   * Separate from staff evaluations: no FK, view, or column links to
--     staff_evaluations / staff_goals, and the staff-evals function is untouched.
--   * Private storage bucket 'hr-documents' (public = false, PDF only, no
--     storage policies => only the service role can read; no public URLs).
--
-- Rollback (only safe before any real documents exist):
--   see 20261026160000_hr_documents_esign.rollback.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Employee HR profile (identity + minor/guardian + department for scoping).
-- Kept separate from checklist_staff (floor board) on purpose: DOB/guardian
-- data must never reach the floor board or any public roster.
-- ---------------------------------------------------------------------------
create table if not exists public.hr_employees (
  id                    uuid primary key default gen_random_uuid(),
  full_name             text not null,
  email                 text,
  phone_last4           text check (phone_last4 is null or phone_last4 ~ '^[0-9]{4}$'),
  -- Date of birth is NEVER stored. Only a keyed HMAC-SHA256 of the normalized
  -- date (YYYY-MM-DD) bound to this employee id, keyed by the HR_DOB_HMAC_KEY
  -- edge-function secret (not in the database). Used only to check the answer
  -- typed on the signing page; it cannot be shown or reversed without the key.
  dob_hmac              text check (dob_hmac is null or dob_hmac ~ '^v1:[0-9a-f]{64}$'),
  -- Set by an HR admin (pre-ticked when a DOB typed in shows under 18 at entry).
  is_minor              boolean not null default false,
  -- Minors only: the first day of the month they turn 18 (month + year only;
  -- the day of birth is not kept). NULL for adults, and cleared when Minor is
  -- unticked. When this month arrives the admin view flags the person so an HR
  -- admin can untick Minor; a daily check also logs it in hr_audit.
  turns_18_month        date,
  guardian_name         text,
  guardian_email        text,
  department            text not null default 'FOH'
                        check (department in ('FOH','BOH','Bar','Events','Management','Other')),
  position              text,
  square_team_member_id text unique,
  checklist_staff_id    uuid unique,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  voided_at             timestamptz,
  void_reason           text,
  constraint hr_employees_turns_18_minor_only check (
    turns_18_month is null or (is_minor and extract(day from turns_18_month) = 1))
);
create index if not exists hr_employees_active_idx on public.hr_employees (active, department);
comment on column public.hr_employees.turns_18_month is
  'Minors only: first day of the month the employee turns 18. NULL for adults. Never the full date of birth.';
comment on column public.hr_employees.dob_hmac is
  'Keyed HMAC of the date of birth (identity check only). The date itself is never stored or returned by any view or API.';

-- Which admin-login roles count as HR admins or managers, and which
-- departments a manager can see. 'owner' (Matt's login) is always full admin
-- in the function and needs no row. Seeded empty: Matt decides.
create table if not exists public.hr_role_scopes (
  role         text primary key,
  label        text not null,
  is_admin     boolean not null default false,   -- true = sees discipline too
  departments  text[] not null default '{}',     -- manager visibility
  created_at   timestamptz not null default now(),
  voided_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- Documents and immutable versions
-- ---------------------------------------------------------------------------
create table if not exists public.hr_documents (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('discipline','policy','training')),
  title            text not null,
  description      text,
  policy_key       text,                 -- e.g. 'alcohol_ack' (drives the unsigned list)
  guardian_for_minors boolean not null default true,
  created_by       text not null,
  created_by_role  text not null,
  created_at       timestamptz not null default now(),
  voided_at        timestamptz,
  void_reason      text
);
create index if not exists hr_documents_kind_idx on public.hr_documents (kind, policy_key);

create table if not exists public.hr_document_versions (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.hr_documents(id),
  version       integer not null,
  source        text not null check (source in ('upload','created')),
  original_filename text,
  body_text     text,                    -- only for 'created' docs
  storage_path  text not null,           -- hr-documents/<...>.pdf
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  page_count    integer not null,
  byte_size     integer not null,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  unique (document_id, version)
);

-- ---------------------------------------------------------------------------
-- Assignments (one document version -> one employee)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_assignments (
  id                    uuid primary key default gen_random_uuid(),
  ref_no                text not null unique,
  document_id           uuid not null references public.hr_documents(id),
  version_id            uuid not null references public.hr_document_versions(id),
  employee_id           uuid not null references public.hr_employees(id),
  kind                  text not null check (kind in ('discipline','policy','training')),
  status                text not null default 'sent'
                        check (status in ('sent','viewed','awaiting_guardian','signed','declined','refused_witnessed','voided')),
  -- employee link: only the SHA-256 of the token is stored
  token_hash            text not null unique,
  token_expires_at      timestamptz not null,
  verify_method         text not null check (verify_method in ('phone4','dob','email_code')),
  verify_fail_count     integer not null default 0,
  verify_locked_at      timestamptz,
  email_code_hash       text,
  email_code_expires_at timestamptz,
  viewed_at             timestamptz,
  -- minors
  guardian_required     boolean not null default false,
  guardian_name         text,
  guardian_email        text,
  guardian_token_hash   text unique,
  guardian_token_expires_at timestamptz,
  guardian_verify_fail_count integer not null default 0,
  guardian_viewed_at    timestamptz,
  -- outcomes
  employee_signed_at    timestamptz,
  guardian_signed_at    timestamptz,
  declined_at           timestamptz,
  declined_by           text check (declined_by is null or declined_by in ('employee','guardian')),
  decline_reason        text,
  refused_at            timestamptz,
  refusal_witness       text,
  refusal_note          text,
  -- "Copy offered to employee?" (required when a refusal is recorded)
  refusal_copy          text check (refusal_copy is null or refusal_copy in ('provided','offered_declined','not_provided')),
  refusal_recorded_by   text,
  completed_at          timestamptz,
  final_pdf_path        text,
  final_pdf_sha256      text check (final_pdf_sha256 is null or final_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  -- bookkeeping
  due_date              date,
  assigned_by           text not null,
  assigned_by_role      text not null,
  last_emailed_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  voided_at             timestamptz,
  void_reason           text,
  constraint hr_assignments_refusal_copy_required check (refused_at is null or refusal_copy is not null),
  constraint hr_assignments_declined_by_set check ((declined_at is null) = (declined_by is null))
);
create index if not exists hr_assignments_emp_idx on public.hr_assignments (employee_id, created_at desc);
create index if not exists hr_assignments_doc_idx on public.hr_assignments (document_id, status);

-- One row per signature (employee and, for minors, parent/guardian). Append-only.
create table if not exists public.hr_signatures (
  id                uuid primary key default gen_random_uuid(),
  assignment_id     uuid not null references public.hr_assignments(id),
  party             text not null check (party in ('employee','guardian')),
  signer_name       text not null,        -- typed full legal name
  signature_method  text not null check (signature_method in ('typed','drawn')),
  signature_image   text,                 -- data:image/png;base64 (drawn only)
  comments          text,
  ack_statement     text not null,        -- exact text shown on the signature line
  consent_statement text not null,        -- exact E-SIGN consent text agreed to
  consent_at        timestamptz not null,
  identity_method   text not null,        -- link+phone4 / link+dob / link+email_code
  ip                text,
  user_agent        text,
  doc_sha256        text not null check (doc_sha256 ~ '^[0-9a-f]{64}$'),
  signed_at         timestamptz not null default now(),
  unique (assignment_id, party)
);

-- Audit trail. Append-only. Times stored UTC; rendered America/Chicago.
create table if not exists public.hr_audit (
  id             bigserial primary key,
  assignment_id  uuid references public.hr_assignments(id),
  document_id    uuid references public.hr_documents(id),
  employee_id    uuid references public.hr_employees(id),
  event          text not null,
  actor          text not null,           -- 'employee' | 'guardian' | admin role/name | 'system'
  ip             text,
  user_agent     text,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists hr_audit_asg_idx on public.hr_audit (assignment_id, created_at);
create index if not exists hr_audit_emp_event_idx on public.hr_audit (employee_id, event, created_at);

-- ---------------------------------------------------------------------------
-- Guards: no hard deletes anywhere; append-only tables; signed docs locked.
-- ---------------------------------------------------------------------------
create or replace function public.hr_block_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'HR records are never deleted (table %). Void it instead.', tg_table_name
    using errcode = '42501';
end $$;

create or replace function public.hr_block_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'HR table % is append-only.', tg_table_name using errcode = '42501';
end $$;

-- Once an assignment is complete (signed / declined / refused), its outcome
-- fields can never change. Only voiding (with a reason) is allowed afterwards,
-- and voiding keeps the record.
create or replace function public.hr_lock_completed_assignment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.completed_at is not null then
    if new.employee_id is distinct from old.employee_id
       or new.version_id is distinct from old.version_id
       or new.document_id is distinct from old.document_id
       or new.employee_signed_at is distinct from old.employee_signed_at
       or new.guardian_signed_at is distinct from old.guardian_signed_at
       or new.declined_at is distinct from old.declined_at
       or new.decline_reason is distinct from old.decline_reason
       or new.declined_by is distinct from old.declined_by
       or new.refused_at is distinct from old.refused_at
       or new.refusal_witness is distinct from old.refusal_witness
       or new.refusal_note is distinct from old.refusal_note
       or new.refusal_copy is distinct from old.refusal_copy
       or new.completed_at is distinct from old.completed_at
       or (old.final_pdf_path is not null and new.final_pdf_path is distinct from old.final_pdf_path)
       or (old.final_pdf_sha256 is not null and new.final_pdf_sha256 is distinct from old.final_pdf_sha256)
    then
      raise exception 'Assignment % is complete and locked.', old.ref_no using errcode = '42501';
    end if;
    if new.status is distinct from old.status and new.status <> 'voided' then
      raise exception 'Assignment % is complete; it can only be voided.', old.ref_no using errcode = '42501';
    end if;
  end if;
  if old.status = 'voided' and (new.status is distinct from old.status or new.voided_at is distinct from old.voided_at
       or new.void_reason is distinct from old.void_reason) then
    raise exception 'Assignment % is voided; that cannot be undone.', old.ref_no using errcode = '42501';
  end if;
  if (new.status = 'voided') <> (new.voided_at is not null) then
    raise exception 'Set status = voided and voided_at together.' using errcode = '23514';
  end if;
  if new.status = 'voided' and coalesce(trim(new.void_reason),'') = '' then
    raise exception 'Voiding needs a reason.' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['hr_employees','hr_role_scopes','hr_documents','hr_document_versions',
                           'hr_assignments','hr_signatures','hr_audit'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.hr_block_delete()', t || '_no_delete', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.hr_block_delete()', t || '_no_truncate', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
  foreach t in array array['hr_document_versions','hr_signatures','hr_audit'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.hr_block_update()', t || '_append_only', t);
  end loop;
end $$;

-- TRUNCATE skips row triggers: a statement trigger above blocks it, and the
-- privilege is revoked too.
revoke truncate on public.hr_employees, public.hr_role_scopes, public.hr_documents,
  public.hr_document_versions, public.hr_assignments, public.hr_signatures, public.hr_audit
  from anon, authenticated, service_role;

drop trigger if exists hr_assignments_lock on public.hr_assignments;
create trigger hr_assignments_lock before update on public.hr_assignments
  for each row execute function public.hr_lock_completed_assignment();

revoke usage on sequence public.hr_audit_id_seq from anon, authenticated;
revoke execute on function public.hr_block_delete(), public.hr_block_update(),
  public.hr_lock_completed_assignment() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Private storage bucket. No storage.objects policies are created, so only
-- the service role can read/write; there are no public URLs.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('hr-documents', 'hr-documents', false, 20971520, array['application/pdf'])
    on conflict (id) do update set public = false;
  end if;
end $$;

commit;
