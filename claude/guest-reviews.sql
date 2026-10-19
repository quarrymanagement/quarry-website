-- ============================================================
-- guest_reviews: Google reviews shown to staff on their evaluation.
-- RLS on, no policies; only the `staff-evals` edge function reads/writes.
-- Applied as migration `guest_reviews`.
-- ============================================================
create table if not exists guest_reviews (
  id             uuid primary key default gen_random_uuid(),
  source         text not null default 'google',
  external_id    text,
  author         text,
  rating         int check (rating between 1 and 5),
  body           text,
  review_date    date,
  owner_reply    text,
  url            text,
  staff_mentions text[] default '{}',
  mgmt_note      text,          -- "what we're changing", shown to staff
  share          boolean not null default true,
  imported_at    timestamptz default now(),
  updated_at     timestamptz default now(),
  unique (source, external_id)
);
create index if not exists idx_gr_date on guest_reviews (review_date desc);
alter table guest_reviews enable row level security;
revoke all on guest_reviews from anon, authenticated;

alter table staff_evaluations add column if not exists feedback_snapshot jsonb;
