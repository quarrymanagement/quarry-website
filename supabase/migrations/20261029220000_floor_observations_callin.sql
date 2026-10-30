-- The Quarry: floor evaluations (server_observations) + call-in reservations.
-- Additive only. New tables, RLS on, NO policies: only the service role
-- (edge functions floor-observations / callin-reservation) can read or write.

-- ---------------------------------------------------------------------------
-- 1. Floor evaluations: what a manager saw on the floor, one row per item.
-- ---------------------------------------------------------------------------
create table if not exists public.server_observations (
  id               uuid primary key default gen_random_uuid(),
  employee_ref     text not null,                 -- same key as staff_evaluations: 'sq:<square id>' / 'cl:<checklist_staff id>' ('test:*' = test rows)
  employee_name    text not null,
  employee_email   text,                          -- snapshot of the staff-record email at send time
  observed_on      date not null default ((now() at time zone 'America/Chicago')::date),
  shift            text check (shift is null or shift in ('lunch','dinner','brunch','event','other')),
  observed_by      text,
  kind             text not null check (kind in ('win','fix')),
  category         text not null check (category in ('service_steps','upsell_menu','speed_attention','alcohol_id','teamwork_sidework','attendance_appearance','guest_recovery')),
  note             text not null check (length(note) between 1 and 4000),
  comment          text check (comment is null or length(comment) <= 4000),   -- manager comment / coaching the employee sees
  marked           boolean not null default false,                            -- re-send next week with history
  followup_due_on  date,                                                      -- observed_on + 7 when marked
  followup_sent_at timestamptz,
  status           text not null default 'draft' check (status in ('draft','approved','sent','voided')),
  approved_by      text,
  approved_at      timestamptz,
  sent_at          timestamptz,
  ack_token        text unique,
  acknowledged_at  timestamptz,
  is_test          boolean not null default false,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists server_observations_ref_idx on public.server_observations (employee_ref, observed_on desc);
create index if not exists server_observations_status_idx on public.server_observations (status, created_at desc);
create index if not exists server_observations_followup_idx on public.server_observations (followup_due_on) where marked and followup_sent_at is null;
alter table public.server_observations enable row level security;

create table if not exists public.server_observation_audit (
  id             uuid primary key default gen_random_uuid(),
  observation_id uuid references public.server_observations(id) on delete cascade,
  employee_ref   text,
  event          text not null,
  actor          text,
  ip             text,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists server_observation_audit_obs_idx on public.server_observation_audit (observation_id, created_at);
alter table public.server_observation_audit enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Call-in reservations taken on the staff iPads (quarry-checklist).
-- ---------------------------------------------------------------------------
create table if not exists public.callin_reservations (
  id                uuid primary key default gen_random_uuid(),
  ref_no            bigint generated always as identity,
  guest_name        text not null check (length(btrim(guest_name)) between 1 and 120),
  guest_phone       text not null check (length(regexp_replace(guest_phone, '\D', '', 'g')) between 7 and 15),
  guest_email       text check (guest_email is null or length(guest_email) <= 200),
  guest_count       integer check (guest_count is null or guest_count between 1 and 2000),
  requested_date    date,
  requested_time    text check (requested_time is null or length(requested_time) <= 40),
  catering          boolean not null default false,
  catering_notes    text check (catering_notes is null or length(catering_notes) <= 2000),
  notes             text check (notes is null or length(notes) <= 4000),
  taken_by          text not null,
  taken_by_staff_id uuid,
  status            text not null default 'new' check (status in ('new','followed_up')),
  followed_up_at    timestamptz,
  followed_up_by    text,
  emailed_at        timestamptz,
  email_error       text,
  is_test           boolean not null default false,
  ip                text,
  user_agent        text,
  created_at        timestamptz not null default now()
);
create index if not exists callin_reservations_created_idx on public.callin_reservations (created_at desc);
create index if not exists callin_reservations_status_idx on public.callin_reservations (status, created_at desc);
alter table public.callin_reservations enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Settings for the floor-observations function (weekly follow-up cron key
--    is stored here as a sha256 hash only; empty = follow-up cron disabled).
-- ---------------------------------------------------------------------------
create table if not exists public.server_observation_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table public.server_observation_settings enable row level security;

revoke all on public.server_observations, public.server_observation_audit,
              public.callin_reservations, public.server_observation_settings from anon, authenticated;
