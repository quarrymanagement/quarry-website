-- ============================================================================
-- Incident Reports + employee/witness statements
-- Admin › Team › Incidents. Service role only (RLS on, no policies);
-- everything goes through the `incidents` edge function.
-- ============================================================================
create sequence if not exists incident_seq;

create table if not exists incidents (
  id               uuid primary key default gen_random_uuid(),
  ref_no           text unique not null default ('IR-' || to_char(now() at time zone 'America/Chicago', 'YYYY') || '-' || lpad(nextval('incident_seq')::text, 3, '0')),
  status           text not null default 'open' check (status in ('open','closed')),
  incident_type    text not null,
  incident_date    date not null,
  incident_time    text,
  location         text,
  summary          text,            -- manager's account of what happened
  people_involved  text,            -- names / descriptions of everyone involved
  injured_name     text,
  injured_contact  text,
  injured_role     text,            -- guest / employee / vendor / other
  injury_details   text,
  medical_response text,            -- none / first_aid / ems / refused / unknown
  police_called    boolean not null default false,
  police_report_no text,
  conditions       text,            -- weather, lighting, floor, signage
  actions_taken    text,
  follow_up        text,
  insurance_notified boolean not null default false,
  reported_by      text,
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists incidents_status_idx on incidents (status, incident_date desc);

create table if not exists incident_statements (
  id               uuid primary key default gen_random_uuid(),
  incident_id      uuid not null references incidents(id) on delete cascade,
  token            text unique not null,
  status           text not null default 'requested' check (status in ('requested','submitted','voided')),
  person_name      text not null,
  person_email     text,
  person_phone     text,
  person_role      text,            -- employee / witness / guest / manager
  requested_by     text,
  requested_at     timestamptz not null default now(),
  opened_at        timestamptz,
  answers          jsonb not null default '{}'::jsonb,
  signed_name      text,
  signature        text,            -- PNG data URL
  submitted_at     timestamptz,
  submit_ip        text,
  submit_user_agent text,
  created_at       timestamptz not null default now()
);
create index if not exists incident_statements_incident_idx on incident_statements (incident_id, created_at);

create table if not exists incident_audit (
  id           bigserial primary key,
  incident_id  uuid not null references incidents(id) on delete cascade,
  statement_id uuid,
  event        text not null,
  actor        text,
  ip           text,
  user_agent   text,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists incident_audit_idx on incident_audit (incident_id, created_at);

alter table incidents enable row level security;
alter table incident_statements enable row level security;
alter table incident_audit enable row level security;
revoke all on incidents, incident_statements, incident_audit from anon, authenticated;
revoke all on sequence incident_seq from anon, authenticated;

-- private bucket for incident PDFs
insert into storage.buckets (id, name, public) values ('incident-reports', 'incident-reports', false) on conflict (id) do nothing;
