-- Phase F.1: Staging & Safety Foundation.
--
-- Two independent enforcement mechanisms, neither of which makes anything live:
--   1. AI usage/cost tracking + hard daily/monthly caps - built and tested here entirely
--      against rows inserted directly (a mock provider's "this call would have cost X" data),
--      because no code anywhere in this project calls a real AI provider yet. The cap trigger
--      exists so that WHENEVER real AI-call code is written later, it already has a hard,
--      already-tested backstop to log against - the trigger simply refuses the insert once a
--      workspace's cap is reached, rather than the cap being an unenforced number to check by
--      hand.
--   2. Paid Ads monthly budget-cap enforcement - workspace_settings.ad_spend_monthly_cap has
--      existed since Phase 1 but nothing ever read it. This migration makes it real: a second,
--      separate trigger on ad_campaigns (Sub-phase E's own private.trg_ad_campaign_before() is
--      NOT edited, to keep its already-tested permission logic untouched) refuses a budget
--      that would put the workspace's live (non-cancelled) campaigns over the cap.
--
-- Nothing in this file launches an ad, spends money, or calls any external provider - it only
-- adds numbers and refusal rules around numbers that already existed.

-- ---------- AI usage tracking ---------------------------------------------------------------

create table public.ai_usage_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_run_id uuid references public.agent_runs (id) on delete set null,
  provider text not null check (char_length(provider) between 1 and 60),
  model text not null check (char_length(model) between 1 and 120),
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  estimated_cost_usd numeric(12, 6) not null check (estimated_cost_usd >= 0),
  created_at timestamptz not null default now()
);
create index ai_usage_log_ws_created_idx on public.ai_usage_log (workspace_id, created_at desc);

alter table public.workspace_settings
  add column ai_daily_call_cap integer check (ai_daily_call_cap is null or ai_daily_call_cap >= 0),
  add column ai_monthly_cost_cap_usd numeric(12, 2) check (ai_monthly_cost_cap_usd is null or ai_monthly_cost_cap_usd >= 0);

-- Refuses the INSERT itself once a cap is already met/would be exceeded - "hard cap" means a
-- refusal, not a warning. NULL caps (the default) mean unlimited, matching
-- ad_spend_monthly_cap's own existing "NULL = no cap set yet" convention.
create or replace function private.trg_ai_usage_cap_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_daily_cap integer;
  v_monthly_cost_cap numeric;
  v_daily_count integer;
  v_monthly_cost numeric;
begin
  select ai_daily_call_cap, ai_monthly_cost_cap_usd into v_daily_cap, v_monthly_cost_cap
    from public.workspace_settings where workspace_id = new.workspace_id;

  if v_daily_cap is not null then
    select count(*) into v_daily_count from public.ai_usage_log
      where workspace_id = new.workspace_id and created_at >= date_trunc('day', now());
    if v_daily_count >= v_daily_cap then
      raise exception 'the daily AI usage cap (% calls) has been reached for this workspace', v_daily_cap;
    end if;
  end if;

  if v_monthly_cost_cap is not null then
    select coalesce(sum(estimated_cost_usd), 0) into v_monthly_cost from public.ai_usage_log
      where workspace_id = new.workspace_id and created_at >= date_trunc('month', now());
    if v_monthly_cost + new.estimated_cost_usd > v_monthly_cost_cap then
      raise exception 'the monthly AI cost cap ($%) would be exceeded for this workspace', v_monthly_cost_cap;
    end if;
  end if;

  return new;
end;
$$;

create trigger ai_usage_log_cap_before before insert on public.ai_usage_log
  for each row execute function private.trg_ai_usage_cap_before();

alter table public.ai_usage_log enable row level security;

-- Admin-only, matching workspace_settings/health_monitor's own precedent - this is cost/ops
-- data, not a workspace feature, so there is no dedicated permission module for it; gating is
-- direct on private.is_admin() rather than the generic can_do()/holds() pair. No insert/update/
-- delete policy for anon/authenticated at all - only the server-side service role ever writes
-- a usage row, exactly like audit_log.
create policy ai_usage_log_select on public.ai_usage_log for select to authenticated
  using (private.is_admin(workspace_id));

revoke all on public.ai_usage_log from anon, authenticated;
grant select on public.ai_usage_log to authenticated;

-- The earlier grant on workspace_settings named only approval_policy/ad_spend_monthly_cap -
-- GRANT is additive, so this simply extends the updatable column set to the two new caps.
grant update (ai_daily_call_cap, ai_monthly_cost_cap_usd) on public.workspace_settings to authenticated;

-- ---------- Paid Ads monthly budget-cap enforcement -----------------------------------------

-- A SEPARATE trigger from Sub-phase E's private.trg_ad_campaign_before() (not edited here, so
-- its already-tested permission logic stays untouched). Triggers on the same table+event fire
-- in name order - "ad_campaigns_before" sorts before "ad_campaigns_budget_cap_before" - so an
-- unauthorized budget change is still refused first, before the cap is ever consulted.
create or replace function private.trg_ad_campaign_budget_cap_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_cap numeric;
  v_total numeric;
begin
  if new.budget_amount is null then return new; end if;
  if tg_op = 'UPDATE' and new.budget_amount is not distinct from old.budget_amount then return new; end if;

  select ad_spend_monthly_cap into v_cap from public.workspace_settings where workspace_id = new.workspace_id;
  if v_cap is null then return new; end if;

  select coalesce(sum(budget_amount), 0) into v_total
    from public.ad_campaigns
    where workspace_id = new.workspace_id
      and status <> 'cancelled'
      and id is distinct from new.id
      and budget_amount is not null;

  v_total := v_total + new.budget_amount;
  if v_total > v_cap then
    raise exception 'this budget would put the workspace over its monthly ad-spend cap ($%)', v_cap;
  end if;

  return new;
end;
$$;

create trigger ad_campaigns_budget_cap_before before insert or update of budget_amount on public.ad_campaigns
  for each row execute function private.trg_ad_campaign_budget_cap_before();
