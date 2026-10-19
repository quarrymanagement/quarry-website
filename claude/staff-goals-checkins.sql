-- ============================================================
-- Goals from the self-evaluation + weekly accountability check-ins.
-- RLS on, no policies; only the `staff-checkins` edge function reads/writes.
-- Applied as migrations `staff_goals_checkins` and `staff_checkins_allow_resend`.
-- ============================================================
create table if not exists staff_goals (
  id             uuid primary key default gen_random_uuid(),
  evaluation_id  uuid references staff_evaluations(id) on delete cascade,
  employee_name  text not null,
  role_key       text,
  area_id        text,
  area_title     text,
  goal           text not null,
  set_by         text not null default 'employee',   -- employee | mgmt
  status         text not null default 'active',     -- active | done | dropped
  closed_at      timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create table if not exists staff_checkins (
  id uuid primary key default gen_random_uuid(), token text unique not null,
  evaluation_id uuid references staff_evaluations(id) on delete set null,
  employee_name text not null, employee_email text, employee_phone text, role_key text,
  week_of date not null,                       -- Monday (Chicago) of the week
  status text not null default 'sent',         -- sent | submitted | voided
  focus_text text, goals_shown jsonb default '[]'::jsonb,
  results jsonb default '[]'::jsonb,           -- [{goal_id, goal, result: done|partly|not_yet, note}]
  new_goal jsonb, sent_by text, sent_at timestamptz default now(), opened_at timestamptz, submitted_at timestamptz,
  mgr_note text, mgr_by text, mgr_at timestamptz
);
create table if not exists staff_weekly_focus (
  role_key text not null, week_of date not null, text text not null, set_by text, updated_at timestamptz default now(),
  primary key (role_key, week_of)
);
alter table staff_goals enable row level security;
alter table staff_checkins enable row level security;
alter table staff_weekly_focus enable row level security;
revoke all on staff_goals, staff_checkins, staff_weekly_focus from anon, authenticated;

-- Positions worked (migration `staff_checkins_positions_worked`)
alter table staff_checkins add column if not exists worked jsonb;          -- {roles:[{key,shifts}], support_shifts, from_square}
alter table staff_checkins add column if not exists support_roles text[];  -- [primary, ...also] picked by the employee
create or replace function public.staff_week_jobs(p_name text, p_week date)
returns table (job_title text, shifts bigint, hours numeric)
language sql stable security definer set search_path = public, square_sync as $$
  select s.job_title, count(*), round(sum(coalesce(s.hours, 0))::numeric, 1)
  from square_sync.shifts s
  where s.deleted_at is null and lower(trim(s.employee_name)) = lower(trim(p_name))
    and s.business_date >= p_week - 7 and s.business_date < p_week
  group by s.job_title order by count(*) desc;
$$;
revoke all on function public.staff_week_jobs(text, date) from public, anon, authenticated;
