-- ============================================================================
-- Training Tests — server (and later busser/host) knowledge + scenario tests
-- sent from Admin › Team › Training Tests. Service role only (RLS on, no
-- policies); everything goes through the `training-tests` edge function.
-- ============================================================================
create sequence if not exists training_test_seq;

create table if not exists training_test_attempts (
  id               uuid primary key default gen_random_uuid(),
  ref_no           text unique not null default ('TT-' || to_char(now() at time zone 'America/Chicago', 'YYYY') || '-' || lpad(nextval('training_test_seq')::text, 3, '0')),
  token            text unique not null,
  test_key         text not null default 'server',
  test_version     int  not null default 1,
  status           text not null default 'sent' check (status in ('sent','in_progress','submitted','reviewed','voided')),
  employee_name    text not null,
  employee_email   text,
  employee_phone   text,
  employee_position text,
  employee_ref     text,
  sent_by          text,
  delivery         text,
  sent_at          timestamptz not null default now(),
  opened_at        timestamptz,
  submitted_at     timestamptz,
  mc_answers       jsonb not null default '{}'::jsonb,   -- { qid: chosen index }
  mc_score         int,
  mc_total         int,
  open_answers     jsonb not null default '{}'::jsonb,   -- { qid: text }
  reviews          jsonb not null default '{}'::jsonb,   -- { qid: { decision: 'approved'|'needs_work', note } }
  overall_decision text check (overall_decision in ('passed','retake')),
  overall_note     text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  submit_ip        text,
  submit_user_agent text,
  void_reason      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists training_test_attempts_status_idx on training_test_attempts (status, created_at desc);
create index if not exists training_test_attempts_name_idx on training_test_attempts (lower(employee_name));

create table if not exists training_test_audit (
  id          bigserial primary key,
  attempt_id  uuid not null references training_test_attempts(id) on delete cascade,
  event       text not null,
  actor       text,
  ip          text,
  user_agent  text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists training_test_audit_attempt_idx on training_test_audit (attempt_id, created_at);

alter table training_test_attempts enable row level security;
alter table training_test_audit enable row level security;
revoke all on training_test_attempts, training_test_audit from anon, authenticated;
revoke all on sequence training_test_seq from anon, authenticated;
