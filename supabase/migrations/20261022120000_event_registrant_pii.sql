-- ============================================================================
-- event_registrant_pii — buyer contact details kept OUT of the public repo.
--
-- events.json lives in a PUBLIC GitHub repo and is served raw to the world.
-- Until 2026-10-22 every ticket registration in it carried the buyer's name,
-- email and phone. From now on writers store those fields here and leave only
-- a `ref` (paymentId / transactionId / orderNumber / hash) on the public row.
--
-- Access: service role only. RLS is ON with NO policies, so anon/authenticated
-- keys (which ship in public pages) can read nothing. The edge function
-- `event-pii` (shared secret EVENT_PII_KEY) is the only path in from Netlify.
--
-- Key: (event_id, ref).
--   event_id = events[].id for per-event registrations and refundedRegistrations
--              'legacy:<map key>' for the old top-level registrations map
--   ref      = paymentId || transactionId || orderNumber || 'h_<sha1 prefix>'
--              (must match regRef() in netlify/functions/_event-pii.js and
--               supabase/functions/square-webhook/index.ts)
-- ============================================================================

create table if not exists public.event_registrant_pii (
  event_id      text        not null,
  ref           text        not null,
  name          text,
  email         text,
  phone         text,
  business_name text,
  business_type text,
  source        text,                       -- which writer last stored it
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (event_id, ref)
);

create index if not exists event_registrant_pii_email_idx
  on public.event_registrant_pii (lower(email));

alter table public.event_registrant_pii enable row level security;
-- Deliberately no policies: only the service role (edge functions) can touch it.
revoke all on public.event_registrant_pii from anon, authenticated;

-- Upsert that never blanks an existing value with null/empty (writers only
-- send what they have; a stripped row never carries PII back).
create or replace function public.event_pii_upsert(p_rows jsonb, p_source text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  insert into public.event_registrant_pii as t
    (event_id, ref, name, email, phone, business_name, business_type, source)
  select
    r->>'event_id', r->>'ref',
    nullif(r->>'name', ''), nullif(r->>'email', ''), nullif(r->>'phone', ''),
    nullif(r->>'business_name', ''), nullif(r->>'business_type', ''),
    p_source
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where coalesce(r->>'event_id', '') <> '' and coalesce(r->>'ref', '') <> ''
  on conflict (event_id, ref) do update set
    name          = coalesce(excluded.name,          t.name),
    email         = coalesce(excluded.email,         t.email),
    phone         = coalesce(excluded.phone,         t.phone),
    business_name = coalesce(excluded.business_name, t.business_name),
    business_type = coalesce(excluded.business_type, t.business_type),
    source        = coalesce(excluded.source,        t.source),
    updated_at    = now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.event_pii_upsert(jsonb, text) from public, anon, authenticated;
grant execute on function public.event_pii_upsert(jsonb, text) to service_role;
