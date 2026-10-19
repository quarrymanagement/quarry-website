-- ============================================================
-- The Quarry — Staff self-evaluations (role-specific)
-- RLS ON with NO policies -> only the service role (the `staff-evals`
-- edge function) can read/write. anon/authenticated revoked.
-- Applied as migration `staff_evaluations`.
-- ============================================================
create sequence if not exists staff_evaluation_seq start 1;

create table if not exists staff_evaluations (
  id                uuid primary key default gen_random_uuid(),
  ref_no            text unique not null
                    default ('EV-' || to_char(now() at time zone 'America/Chicago', 'YYYY') || '-' ||
                             lpad(nextval('staff_evaluation_seq')::text, 4, '0')),
  token             text unique not null,
  role_key          text not null,          -- server | host | busser | expo | bartender | kitchen
  form_version      int  not null default 1,
  status            text not null default 'sent', -- sent | in_progress | submitted | responded | acknowledged | voided
  batch_id          uuid,                   -- one "send to role" click

  employee_name     text not null,
  employee_email    text,
  employee_phone    text,
  employee_ref      text,                   -- sq:<id> / cl:<id>
  sent_by           text,
  delivery          text,                   -- email | text | link

  sent_at           timestamptz default now(),
  opened_at         timestamptz,
  submitted_at      timestamptz,

  -- employee
  self_ratings      jsonb default '{}'::jsonb,   -- {area_id: 1..5}
  self_examples     jsonb default '{}'::jsonb,   -- {area_id: text}
  open_answers      jsonb default '{}'::jsonb,   -- {strong|hardest|need: text}
  submit_ip         text,
  submit_user_agent text,

  -- management
  mgr_ratings       jsonb default '{}'::jsonb,
  mgr_notes         jsonb default '{}'::jsonb,
  strengths         text,
  focus             text,                        -- next 30 days
  overall_note      text,
  responded_by      text,
  responded_at      timestamptz,

  -- employee reflection
  reflection        text,
  acknowledged_at   timestamptz,
  ack_ip            text,

  void_reason       text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create table if not exists staff_evaluation_audit (
  id             uuid primary key default gen_random_uuid(),
  evaluation_id  uuid references staff_evaluations(id) on delete cascade,
  event          text not null,  -- sent|emailed|opened|submitted|response_saved|responded|acknowledged|reminded|voided
  actor          text,
  ip             text,
  user_agent     text,
  detail         jsonb default '{}'::jsonb,
  created_at     timestamptz default now()
);

create index if not exists idx_ev_name   on staff_evaluations (lower(employee_name));
create index if not exists idx_ev_status on staff_evaluations (status);
create index if not exists idx_ev_role   on staff_evaluations (role_key);
create index if not exists idx_ev_audit  on staff_evaluation_audit (evaluation_id);

alter table staff_evaluations      enable row level security;
alter table staff_evaluation_audit enable row level security;
revoke all on staff_evaluations, staff_evaluation_audit from anon, authenticated;
revoke all on sequence staff_evaluation_seq from anon, authenticated;
