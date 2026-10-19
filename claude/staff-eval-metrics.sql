-- ============================================================
-- staff_eval_metrics(name, days) -> jsonb
-- Per-employee numbers for the evaluation response screen, with the
-- average for others in the same Square job title over the same window.
-- Called only by the `staff-evals` edge function (service role).
-- Applied as migration `staff_eval_metrics`.
-- ============================================================
alter table staff_evaluations add column if not exists metrics_snapshot jsonb;

create or replace function public.staff_eval_metrics(p_name text, p_days int default 60)
returns jsonb
language sql
stable
security definer
set search_path = public, square_sync
as $$
with win as (select (current_date - p_days) d0),
-- every person who worked in the window, with their main job title
ppl as (
  select team_member_id, max(employee_name) employee_name,
         (array_agg(job_title order by hrs desc))[1] job_title, sum(hrs) hours, sum(n) shifts, sum(longn) long_shifts
  from (select team_member_id, employee_name, job_title, sum(hours) hrs, count(*) n, count(*) filter (where hours > 12) longn
        from square_sync.shifts, win where business_date >= d0 and deleted_at is null and team_member_id is not null
        group by 1,2,3) x
  group by 1
),
ord as (
  select team_member_id, count(*) checks, sum(net_sales_cents) net, sum(tip_cents) tips,
         avg(extract(epoch from (closed_at - opened_at)) / 60) filter (where closed_at > opened_at and closed_at - opened_at < interval '6 hours') mins
  from square_sync.order_header, win where business_date >= d0 and state = 'COMPLETED' group by 1
),
pay as (
  select team_member_id, sum(amount_cents) filter (where source_type = 'CASH') cash, count(*) filter (where source_type = 'CASH') cash_n
  from square_sync.order_tips, win where business_date >= d0 and status = 'COMPLETED' group by 1
),
dec as (
  select team_member_id, sum(declared_tips_cents) declared from square_sync.shifts, win where business_date >= d0 and deleted_at is null group by 1
),
comp as (
  select employee_id team_member_id,
         count(*) filter (where discount_name ilike 'customer complaint') complaint,
         count(*) filter (where discount_name ilike 'entry error') entry_error,
         count(*) filter (where discount_name ilike 'customer changed mind') changed_mind,
         count(*) filter (where discount_name not ilike 'employee%' and discount_name not ilike any (array['customer complaint','entry error','customer changed mind'])) other,
         sum(amount_cents) filter (where discount_name not ilike 'employee%') comp_cents
  from square_sync.discount_detail, win where business_date >= d0 group by 1
),
per as (
  select p.team_member_id, p.employee_name, p.job_title, p.hours, p.shifts, p.long_shifts,
         o.checks, o.net, o.tips, o.mins, y.cash, y.cash_n, d.declared,
         c.complaint, c.entry_error, c.changed_mind, c.other, c.comp_cents,
         case when o.checks > 0 then o.net::numeric / o.checks end avg_check,
         case when o.net > 0 then 100.0 * o.tips / o.net end tip_pct,
         case when o.checks > 0 then 100.0 * (coalesce(c.complaint,0) + coalesce(c.entry_error,0) + coalesce(c.changed_mind,0) + coalesce(c.other,0)) / o.checks end comps_per_100,
         case when y.cash > 0 then 100.0 * coalesce(d.declared,0) / y.cash end declared_pct_of_cash
  from ppl p left join ord o using (team_member_id) left join pay y using (team_member_id)
       left join dec d using (team_member_id) left join comp c using (team_member_id)
),
me as (select * from per where lower(employee_name) = lower(trim(p_name)) order by hours desc nulls last limit 1),
peers as (select * from per where job_title = (select job_title from me) and team_member_id <> (select team_member_id from me) and hours >= 10),
chk as (
  select count(*) n, count(distinct business_date) days from checklist_logs, win
  where business_date >= d0 and lower(staff_name) = lower(trim(p_name))
),
tt as (
  select ref_no, mc_score, mc_total, overall_decision, submitted_at from training_test_attempts
  where lower(employee_name) = lower(trim(p_name)) and status in ('submitted','reviewed') order by submitted_at desc limit 1
)
select jsonb_build_object(
  'days', p_days,
  'found', exists (select 1 from me),
  'me', (select to_jsonb(me) - 'team_member_id' from me),
  'peers', (select jsonb_build_object(
      'n', count(*),
      'hours', round(avg(hours)::numeric, 1), 'shifts', round(avg(shifts)::numeric, 1),
      'checks', round(avg(checks)::numeric, 0), 'avg_check', round(avg(avg_check)::numeric, 0),
      'mins', round(avg(mins)::numeric, 0), 'tip_pct', round(avg(tip_pct)::numeric, 1),
      'comps_per_100', round(avg(comps_per_100)::numeric, 1), 'declared_pct_of_cash', round(avg(declared_pct_of_cash)::numeric, 1),
      'long_shifts', round(avg(long_shifts)::numeric, 1)) from peers),
  'checklist', (select to_jsonb(chk) from chk),
  'training', (select to_jsonb(tt) from tt),
  'comp_approvals_recorded', (select count(*) filter (where approver_id is not null) from square_sync.discount_detail, win where business_date >= d0)
);
$$;

revoke all on function public.staff_eval_metrics(text, int) from public, anon, authenticated;
