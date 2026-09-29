-- =====================================================================================
-- VMS Autopilot - Runtime-Agent Phase, Sub-phase E: Paid Ads (+ Audience & Targeting),
-- Lead/CRM, Website/Domain Agents (SANDBOX ONLY)
--
-- Run AFTER migration 20260929000400_health_monitor.sql. Adds ONLY new tables and new
-- functions - nothing here changes any existing table, enum, policy or trigger from Phases
-- 1-4 or Sub-phases A/B/C/D. In particular social_interactions (migration 20260929000200) is
-- read, never altered: leads captured from a comment/DM keep a real foreign key back to it.
--
-- Every table here reuses an EXISTING permission module from Phase 1 (paid_ads, leads_crm,
-- website, domains) and that module's EXISTING actions - no new permission module or action
-- anywhere in this file. Each module's real Phase 1 shape is followed exactly, not smoothed
-- over: paid_ads:create needs an explicit grant (never a Client default); website's Client
-- ceiling is 'view' only (a Client can never draft one, however it is granted); leads_crm has
-- nothing sensitive except delete (the lightest-touch module in the system); domains has NO
-- Client default at all and create/edit/publish_execute are all sensitive.
--
-- What this file adds, in plain words:
--   * ad_audience_briefs - the Paid Ads Audience & Targeting Agent's own output. Deliberately
--     lighter than every other approval-gated table here (approved design decision): a
--     "draft"/"final" state, not the full hash-freeze-and-second-approver ceremony, because a
--     brief is a recommendation, not a live ad action. It is still fully auditable (every
--     change reaches audit_log) and versioned (an integer that advances on every draft edit;
--     once "final" it is locked - editing it at all is refused, so the version an
--     ad_campaigns row points at can never silently change under it).
--   * ad_campaigns / ad_creatives - the Paid Ads Agent's own output. FULL rigor (approval hash,
--     second-approver rule): draft -> in_review -> approved/cancelled. There is deliberately
--     NO "active"/"launched" status - nothing in this project can spend money or touch a real
--     ad account yet. A campaign that references a brief may only reference a FINAL one - the
--     database itself enforces "the final brief is the approved input for campaign planning
--     only".
--   * leads / lead_activities - the Lead/CRM Agent's own output. Creating and qualifying a
--     lead reuses leads_crm:create/edit, neither of which Phase 1 ever made sensitive - this
--     is not a new relaxation, it is the module's real existing shape. A lead captured from a
--     social comment/DM keeps a real foreign key back to social_interactions. There is no
--     "send" tool anywhere: a drafted follow-up is text that sits in lead_activities forever
--     until a human sends it some other way.
--   * website_projects - the Website/Domain Agent's own output. Full rigor, same shape as
--     content_drafts: draft -> in_review -> approved/cancelled, no "deployed" status.
--   * Domain name suggestions and availability checks are NOT written to a table at all - they
--     are pure, input-driven computation (like research_strategy in Sub-phase B), recorded
--     only in the agent's own agent_runs.output (already built in Sub-phase A). A persisted
--     domains-module table would have to be gated by domains:view/create, and domains has NO
--     Client default and create is sensitive - gating a harmless "suggest some names" step
--     behind an Admin-approval-shaped permission would be wrong, so this phase doesn't do it.
--     This is a deliberate refinement made during implementation, reported honestly rather
--     than shipped quietly (see the Sub-phase E summary).
-- =====================================================================================

create type public.ad_platform as enum ('meta', 'google');
create type public.ad_audience_brief_status as enum ('draft', 'final');
create type public.ad_campaign_status as enum ('draft', 'in_review', 'approved', 'cancelled');
create type public.lead_source as enum ('form', 'whatsapp', 'social_dm', 'manual');
create type public.lead_status as enum ('new', 'contacted', 'qualified', 'converted', 'lost');
create type public.website_provider as enum ('vercel', 'lovable', 'emergent', 'google_ai_studio', 'other');
create type public.website_project_status as enum ('draft', 'in_review', 'approved', 'cancelled');

-- ---------- Tables ----------------------------------------------------------------------

create table public.ad_audience_briefs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  business_profile jsonb not null check (jsonb_typeof(business_profile) = 'object'),
  platform public.ad_platform not null default 'meta',
  hypotheses jsonb not null default '[]'::jsonb check (jsonb_typeof(hypotheses) = 'array'),
  segments jsonb not null default '[]'::jsonb check (jsonb_typeof(segments) = 'array'),
  recommended_objective text check (recommended_objective is null or char_length(recommended_objective) <= 200),
  recommended_offer text check (recommended_offer is null or char_length(recommended_offer) <= 500),
  conversion_signals jsonb not null default '{}'::jsonb check (jsonb_typeof(conversion_signals) = 'object'),
  status public.ad_audience_brief_status not null default 'draft',
  version integer not null default 1 check (version >= 1),
  drafted_by_agent boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_by uuid references auth.users (id) on delete set null,
  finalized_at timestamptz,
  constraint ad_audience_brief_final_consistent check (
    (status = 'final' and finalized_at is not null) or (status = 'draft' and finalized_at is null)
  )
);
create index ad_audience_briefs_ws_idx on public.ad_audience_briefs (workspace_id, status);

create table public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  audience_brief_id uuid references public.ad_audience_briefs (id) on delete set null,
  platform public.ad_platform not null,
  objective text not null check (char_length(objective) between 1 and 200),
  name text not null check (char_length(name) between 1 and 200),
  status public.ad_campaign_status not null default 'draft',
  budget_amount numeric(12, 2) check (budget_amount is null or budget_amount >= 0),
  budget_period text check (budget_period is null or budget_period in ('daily', 'lifetime')),
  drafted_by_agent boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approved_hash text check (approved_hash is null or approved_hash ~ '^[0-9a-f]{64}$'),
  constraint ad_campaign_shape check (
    (status = 'approved' and approved_hash is not null) or (status <> 'approved')
  )
);
create index ad_campaigns_ws_idx on public.ad_campaigns (workspace_id, status);
create index ad_campaigns_brief_idx on public.ad_campaigns (audience_brief_id);

create table public.ad_creatives (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  headline text not null check (char_length(headline) between 1 and 120),
  body text not null check (char_length(body) between 1 and 2000),
  call_to_action text check (call_to_action is null or char_length(call_to_action) <= 60),
  image_ref text check (image_ref is null or char_length(image_ref) <= 200),
  created_at timestamptz not null default now()
);
create index ad_creatives_campaign_idx on public.ad_creatives (campaign_id);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source public.lead_source not null,
  name text check (name is null or char_length(name) <= 200),
  contact text check (contact is null or char_length(contact) <= 200),
  status public.lead_status not null default 'new',
  notes text check (notes is null or char_length(notes) <= 2000),
  assigned_to uuid references auth.users (id) on delete set null,
  -- Preserves the link back to the comment/DM that produced this lead (Sub-phase B).
  source_interaction_id uuid references public.social_interactions (id) on delete set null,
  drafted_by_agent boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_ws_idx on public.leads (workspace_id, status);
create index leads_interaction_idx on public.leads (source_interaction_id);
-- A given interaction produces at most one lead - the compatibility rule below is idempotent.
create unique index leads_interaction_uniq on public.leads (source_interaction_id) where source_interaction_id is not null;

create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('note', 'follow_up_drafted', 'status_changed')),
  body text not null check (char_length(body) between 1 and 2000),
  drafted_by_agent boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index lead_activities_lead_idx on public.lead_activities (lead_id, created_at desc);

create table public.website_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider public.website_provider not null,
  title text not null check (char_length(title) between 1 and 200),
  pages jsonb not null default '[]'::jsonb check (jsonb_typeof(pages) = 'array'),
  status public.website_project_status not null default 'draft',
  drafted_by_agent boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approved_hash text check (approved_hash is null or approved_hash ~ '^[0-9a-f]{64}$'),
  constraint website_project_shape check (
    (status = 'approved' and approved_hash is not null) or (status <> 'approved')
  )
);
create index website_projects_ws_idx on public.website_projects (workspace_id, status);

alter table public.ad_audience_briefs enable row level security;
alter table public.ad_campaigns enable row level security;
alter table public.ad_creatives enable row level security;
alter table public.leads enable row level security;
alter table public.lead_activities enable row level security;
alter table public.website_projects enable row level security;

-- ---------- Helpers -----------------------------------------------------------------------

create or replace function private.ad_campaign_required_actions(p_from public.ad_campaign_status, p_to public.ad_campaign_status)
returns text[] language sql immutable set search_path = ''
as $$
  select case
    when p_from = 'draft' and p_to = 'in_review' then array['create', 'edit']
    when p_from = 'draft' and p_to = 'cancelled' then array['edit']
    when p_from = 'in_review' and p_to = 'draft' then array['approve', 'edit']
    when p_from = 'in_review' and p_to = 'approved' then array['approve']
    when p_from = 'in_review' and p_to = 'cancelled' then array['edit']
    when p_from = 'approved' and p_to = 'draft' then array['edit']
    when p_from = 'approved' and p_to = 'cancelled' then array['edit']
  end
$$;

create or replace function private.ad_campaign_hash(p_name text, p_objective text, p_budget numeric)
returns text language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(p_name || chr(10) || p_objective || chr(10) || coalesce(p_budget::text, ''), 'UTF8')), 'hex')
$$;

create or replace function private.website_project_required_actions(p_from public.website_project_status, p_to public.website_project_status)
returns text[] language sql immutable set search_path = ''
as $$
  select case
    when p_from = 'draft' and p_to = 'in_review' then array['create', 'edit']
    when p_from = 'draft' and p_to = 'cancelled' then array['edit']
    when p_from = 'in_review' and p_to = 'draft' then array['approve', 'edit']
    when p_from = 'in_review' and p_to = 'approved' then array['approve']
    when p_from = 'in_review' and p_to = 'cancelled' then array['edit']
    when p_from = 'approved' and p_to = 'draft' then array['edit']
    when p_from = 'approved' and p_to = 'cancelled' then array['edit']
  end
$$;

create or replace function private.website_project_hash(p_title text, p_pages jsonb)
returns text language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(p_title || chr(10) || p_pages::text, 'UTF8')), 'hex')
$$;

-- ---------- ad_audience_briefs (lighter model: draft/final, versioned, immutable once final) ---

create or replace function private.trg_ad_audience_brief_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_content_changed boolean;
begin
  if tg_op = 'INSERT' then
    if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
    new.status := 'draft';
    new.version := 1;
    new.finalized_by := null; new.finalized_at := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;

  if new.workspace_id <> old.workspace_id or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
    raise exception 'a brief''s workspace and author cannot be changed';
  end if;
  if old.status = 'final' then
    raise exception 'a finalized audience brief is locked - it is the approved input for campaign planning only and cannot be changed';
  end if;

  v_content_changed := new.business_profile is distinct from old.business_profile
    or new.platform <> old.platform or new.hypotheses is distinct from old.hypotheses
    or new.segments is distinct from old.segments or new.recommended_objective is distinct from old.recommended_objective
    or new.recommended_offer is distinct from old.recommended_offer or new.conversion_signals is distinct from old.conversion_signals;

  if new.status = old.status then
    if v_content_changed then
      if v_uid is not null and not private.can_do(new.workspace_id, 'paid_ads', 'edit') and not private.can_do(new.workspace_id, 'paid_ads', 'create') then
        raise exception 'you do not have permission to edit this audience brief';
      end if;
      new.version := old.version + 1;
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- The only legal status change is draft -> final.
  if old.status <> 'draft' or new.status <> 'final' then
    raise exception 'a brief that is % cannot become %', old.status, new.status;
  end if;
  if v_uid is not null and not private.can_do(new.workspace_id, 'paid_ads', 'create') and not private.can_do(new.workspace_id, 'paid_ads', 'edit') then
    raise exception 'you do not have permission to finalize this audience brief';
  end if;
  if v_uid is not null then new.finalized_by := v_uid; end if;
  new.finalized_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger ad_audience_briefs_before before insert or update on public.ad_audience_briefs
  for each row execute function private.trg_ad_audience_brief_before();

-- ---------- ad_campaigns (full rigor) -----------------------------------------------------

create or replace function private.trg_ad_campaign_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_required text[];
  v_action text;
  v_allowed boolean := false;
  v_content_changed boolean;
  v_status_changed boolean;
begin
  if new.audience_brief_id is not null then
    if not exists (select 1 from public.ad_audience_briefs b where b.id = new.audience_brief_id and b.workspace_id = new.workspace_id and b.status = 'final') then
      raise exception 'a campaign may only reference a FINAL audience brief in this workspace - it is the approved input for campaign planning only';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if btrim(new.name) = '' or btrim(new.objective) = '' then raise exception 'the campaign needs a name and an objective'; end if;
    if v_uid is not null then new.created_by := v_uid; end if;
    new.status := 'draft';
    new.approved_by := null; new.approved_at := null; new.approved_hash := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;

  if new.workspace_id <> old.workspace_id or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at or new.drafted_by_agent <> old.drafted_by_agent then
    raise exception 'a campaign''s workspace, author and origin cannot be changed';
  end if;

  v_content_changed := new.name <> old.name or new.objective <> old.objective or new.budget_amount is distinct from old.budget_amount or new.budget_period is distinct from old.budget_period;
  v_status_changed := new.status <> old.status;

  if v_content_changed then
    if v_status_changed then raise exception 'change the campaign and its status in separate steps'; end if;
    -- Any budget change is publish_execute-shaped (sensitive) per PRD 5.6; a plain rename/
    -- objective tweak only needs edit. Require the stricter one whenever budget moved.
    if v_uid is not null then
      if new.budget_amount is distinct from old.budget_amount or new.budget_period is distinct from old.budget_period then
        if not private.can_do(new.workspace_id, 'paid_ads', 'publish_execute') then
          raise exception 'changing the budget needs an Admin (it is a sensitive action)';
        end if;
      elsif not private.can_do(new.workspace_id, 'paid_ads', 'edit') then
        raise exception 'you do not have permission to edit this campaign';
      end if;
    end if;
    if old.status <> 'draft' then
      new.status := 'draft';
      new.approved_by := null; new.approved_at := null; new.approved_hash := null;
    end if;
    new.updated_at := now();
    return new;
  end if;

  if not v_status_changed then
    new.updated_at := now();
    return new;
  end if;

  v_required := private.ad_campaign_required_actions(old.status, new.status);
  if v_required is null then raise exception 'a campaign that is % cannot become %', old.status, new.status; end if;
  if v_uid is not null then
    foreach v_action in array v_required loop
      if private.can_do(new.workspace_id, 'paid_ads', v_action::public.permission_action) then v_allowed := true; end if;
    end loop;
    if not v_allowed then raise exception 'you do not have permission to make that change'; end if;
  end if;

  if new.status = 'approved' and old.status = 'in_review' then
    if v_uid is null then raise exception 'a person must approve a campaign'; end if;
    if (old.created_by = v_uid or old.created_by is null) and not private.is_admin(new.workspace_id) then
      raise exception 'a second person needs to approve this campaign; you cannot approve one you wrote';
    end if;
    new.approved_by := v_uid; new.approved_at := now();
    new.approved_hash := private.ad_campaign_hash(new.name, new.objective, new.budget_amount);
  elsif new.status = 'draft' then
    new.approved_by := null; new.approved_at := null; new.approved_hash := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger ad_campaigns_before before insert or update on public.ad_campaigns
  for each row execute function private.trg_ad_campaign_before();

create or replace function private.trg_ad_creative_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_campaign public.ad_campaigns;
begin
  select * into v_campaign from public.ad_campaigns c where c.id = new.campaign_id;
  if not found or v_campaign.workspace_id <> new.workspace_id then
    raise exception 'that campaign does not exist in this workspace';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger ad_creatives_before before insert on public.ad_creatives
  for each row execute function private.trg_ad_creative_before();

-- ---------- leads / lead_activities (the lightest-touch module - nothing sensitive here) ----

create or replace function private.trg_lead_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.source_interaction_id is not null and not exists (
    select 1 from public.social_interactions i where i.id = new.source_interaction_id and i.workspace_id = new.workspace_id
  ) then
    raise exception 'that interaction does not exist in this workspace';
  end if;
  if tg_op = 'INSERT' then
    if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
    new.created_at := now();
  else
    if new.workspace_id <> old.workspace_id or new.created_by is distinct from old.created_by
       or new.created_at <> old.created_at or new.source_interaction_id is distinct from old.source_interaction_id then
      raise exception 'a lead''s workspace, author, creation time and source interaction cannot be changed';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger leads_before before insert or update on public.leads
  for each row execute function private.trg_lead_before();

create or replace function private.trg_lead_activity_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
begin
  select * into v_lead from public.leads l where l.id = new.lead_id;
  if not found or v_lead.workspace_id <> new.workspace_id then
    raise exception 'that lead does not exist in this workspace';
  end if;
  if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger lead_activities_before before insert on public.lead_activities
  for each row execute function private.trg_lead_activity_before();

-- ---------- website_projects (full rigor) -------------------------------------------------

create or replace function private.trg_website_project_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_required text[];
  v_action text;
  v_allowed boolean := false;
  v_content_changed boolean;
  v_status_changed boolean;
begin
  if tg_op = 'INSERT' then
    if btrim(new.title) = '' then raise exception 'the website plan needs a title'; end if;
    if v_uid is not null then new.created_by := v_uid; end if;
    new.status := 'draft';
    new.approved_by := null; new.approved_at := null; new.approved_hash := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;

  if new.workspace_id <> old.workspace_id or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at or new.drafted_by_agent <> old.drafted_by_agent or new.provider <> old.provider then
    raise exception 'a website plan''s workspace, author, origin and provider cannot be changed';
  end if;

  v_content_changed := new.title <> old.title or new.pages is distinct from old.pages;
  v_status_changed := new.status <> old.status;

  if v_content_changed then
    if v_status_changed then raise exception 'change the plan and its status in separate steps'; end if;
    if v_uid is not null and not private.can_do(new.workspace_id, 'website', 'edit') then
      raise exception 'you do not have permission to edit this website plan';
    end if;
    if btrim(new.title) = '' then raise exception 'the website plan needs a title'; end if;
    if old.status <> 'draft' then
      new.status := 'draft';
      new.approved_by := null; new.approved_at := null; new.approved_hash := null;
    end if;
    new.updated_at := now();
    return new;
  end if;

  if not v_status_changed then
    new.updated_at := now();
    return new;
  end if;

  v_required := private.website_project_required_actions(old.status, new.status);
  if v_required is null then raise exception 'a plan that is % cannot become %', old.status, new.status; end if;
  if v_uid is not null then
    foreach v_action in array v_required loop
      if private.can_do(new.workspace_id, 'website', v_action::public.permission_action) then v_allowed := true; end if;
    end loop;
    if not v_allowed then raise exception 'you do not have permission to make that change'; end if;
  end if;

  if new.status = 'approved' and old.status = 'in_review' then
    if v_uid is null then raise exception 'a person must approve a website plan'; end if;
    if (old.created_by = v_uid or old.created_by is null) and not private.is_admin(new.workspace_id) then
      raise exception 'a second person needs to approve this plan; you cannot approve one you wrote';
    end if;
    new.approved_by := v_uid; new.approved_at := now();
    new.approved_hash := private.website_project_hash(new.title, new.pages);
  elsif new.status = 'draft' then
    new.approved_by := null; new.approved_at := null; new.approved_hash := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger website_projects_before before insert or update on public.website_projects
  for each row execute function private.trg_website_project_before();

-- ---------- Audit trail ---------------------------------------------------------------------

create or replace function private.trg_audit_paid_ads()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_action text;
  v_meta jsonb;
  v_ws uuid;
begin
  if tg_table_name = 'ad_audience_briefs' then
    v_ws := new.workspace_id;
    v_action := case when tg_op = 'INSERT' then 'ads.brief_created' when new.status = 'final' and old.status = 'draft' then 'ads.brief_finalized' else 'ads.brief_updated' end;
    v_meta := jsonb_build_object('version', new.version, 'status', new.status, 'platform', new.platform);
  elsif tg_table_name = 'ad_campaigns' then
    v_ws := new.workspace_id;
    if tg_op = 'INSERT' then v_action := 'ads.campaign_created';
    elsif new.name <> old.name or new.objective <> old.objective then v_action := 'ads.campaign_edited';
    elsif new.budget_amount is distinct from old.budget_amount then v_action := 'ads.campaign_budget_changed';
    else v_action := 'ads.campaign_' || new.status::text; end if;
    v_meta := jsonb_build_object('status', new.status, 'budget_amount', new.budget_amount, 'approved_hash', new.approved_hash);
  else -- ad_creatives
    v_ws := new.workspace_id;
    v_action := 'ads.creative_added';
    v_meta := jsonb_build_object('campaign_id', new.campaign_id);
  end if;
  insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, metadata)
  values (v_uid, case when v_uid is null then 'system' else private.role_of_user(v_uid, v_ws)::text end, v_ws, 'paid_ads', v_action, tg_table_name, new.id::text, 'success', private.scrub_secrets(v_meta));
  return new;
end;
$$;

create trigger ad_audience_briefs_audit after insert or update on public.ad_audience_briefs
  for each row execute function private.trg_audit_paid_ads();
create trigger ad_campaigns_audit after insert or update on public.ad_campaigns
  for each row execute function private.trg_audit_paid_ads();
create trigger ad_creatives_audit after insert on public.ad_creatives
  for each row execute function private.trg_audit_paid_ads();

create or replace function private.trg_audit_leads_crm()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_action text;
  v_meta jsonb;
begin
  if tg_table_name = 'leads' then
    v_action := case when tg_op = 'INSERT' then 'leads.captured' when new.status <> old.status then 'leads.status_' || new.status::text else 'leads.updated' end;
    v_meta := jsonb_build_object('source', new.source, 'status', new.status, 'source_interaction_id', new.source_interaction_id, 'drafted_by_agent', new.drafted_by_agent);
    insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, metadata)
    values (v_uid, case when v_uid is null then 'system' else private.role_of_user(v_uid, new.workspace_id)::text end, new.workspace_id, 'leads_crm', v_action, 'leads', new.id::text, 'success', private.scrub_secrets(v_meta));
  else -- lead_activities
    v_meta := jsonb_build_object('lead_id', new.lead_id, 'kind', new.kind, 'drafted_by_agent', new.drafted_by_agent);
    insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, metadata)
    values (v_uid, case when v_uid is null then 'system' else private.role_of_user(v_uid, new.workspace_id)::text end, new.workspace_id, 'leads_crm', 'leads.activity_' || new.kind, 'lead_activities', new.id::text, 'success', private.scrub_secrets(v_meta));
  end if;
  return new;
end;
$$;

create trigger leads_audit after insert or update on public.leads
  for each row execute function private.trg_audit_leads_crm();
create trigger lead_activities_audit after insert on public.lead_activities
  for each row execute function private.trg_audit_leads_crm();

create or replace function private.trg_audit_website()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_action text;
  v_meta jsonb;
begin
  if tg_op = 'INSERT' then v_action := 'website.plan_created';
  elsif new.title <> old.title or new.pages is distinct from old.pages then v_action := 'website.plan_edited';
  else v_action := 'website.plan_' || new.status::text; end if;
  v_meta := jsonb_build_object('provider', new.provider, 'status', new.status, 'approved_hash', new.approved_hash);
  insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, metadata)
  values (v_uid, case when v_uid is null then 'system' else private.role_of_user(v_uid, new.workspace_id)::text end, new.workspace_id, 'website', v_action, 'website_projects', new.id::text, 'success', private.scrub_secrets(v_meta));
  return new;
end;
$$;

create trigger website_projects_audit after insert or update on public.website_projects
  for each row execute function private.trg_audit_website();

-- ---------- Row Level Security ----------------------------------------------------------

create policy ad_audience_briefs_select on public.ad_audience_briefs for select to authenticated
  using (private.holds(workspace_id, 'paid_ads', 'view'));
create policy ad_audience_briefs_insert on public.ad_audience_briefs for insert to authenticated
  with check (private.can_do(workspace_id, 'paid_ads', 'create'));
create policy ad_audience_briefs_update on public.ad_audience_briefs for update to authenticated
  using (private.holds(workspace_id, 'paid_ads', 'view')) with check (private.holds(workspace_id, 'paid_ads', 'view'));

create policy ad_campaigns_select on public.ad_campaigns for select to authenticated
  using (private.holds(workspace_id, 'paid_ads', 'view'));
create policy ad_campaigns_insert on public.ad_campaigns for insert to authenticated
  with check (private.can_do(workspace_id, 'paid_ads', 'create'));
create policy ad_campaigns_update on public.ad_campaigns for update to authenticated
  using (private.holds(workspace_id, 'paid_ads', 'view')) with check (private.holds(workspace_id, 'paid_ads', 'view'));

create policy ad_creatives_select on public.ad_creatives for select to authenticated
  using (private.holds(workspace_id, 'paid_ads', 'view'));
create policy ad_creatives_insert on public.ad_creatives for insert to authenticated
  with check (private.can_do(workspace_id, 'paid_ads', 'create'));

create policy leads_select on public.leads for select to authenticated
  using (private.holds(workspace_id, 'leads_crm', 'view'));
create policy leads_insert on public.leads for insert to authenticated
  with check (private.can_do(workspace_id, 'leads_crm', 'create'));
create policy leads_update on public.leads for update to authenticated
  using (private.can_do(workspace_id, 'leads_crm', 'edit')) with check (private.can_do(workspace_id, 'leads_crm', 'edit'));

create policy lead_activities_select on public.lead_activities for select to authenticated
  using (private.holds(workspace_id, 'leads_crm', 'view'));
create policy lead_activities_insert on public.lead_activities for insert to authenticated
  with check (private.can_do(workspace_id, 'leads_crm', 'create'));

create policy website_projects_select on public.website_projects for select to authenticated
  using (private.holds(workspace_id, 'website', 'view'));
create policy website_projects_insert on public.website_projects for insert to authenticated
  with check (private.can_do(workspace_id, 'website', 'create'));
create policy website_projects_update on public.website_projects for update to authenticated
  using (private.holds(workspace_id, 'website', 'view')) with check (private.holds(workspace_id, 'website', 'view'));

-- ---------- Privileges ------------------------------------------------------------------

revoke all on public.ad_audience_briefs, public.ad_campaigns, public.ad_creatives, public.leads, public.lead_activities, public.website_projects
  from anon, authenticated;

grant select on public.ad_audience_briefs to authenticated;
grant insert (workspace_id, business_profile, platform, hypotheses, segments, recommended_objective, recommended_offer, conversion_signals) on public.ad_audience_briefs to authenticated;
grant update (business_profile, platform, hypotheses, segments, recommended_objective, recommended_offer, conversion_signals, status) on public.ad_audience_briefs to authenticated;

grant select on public.ad_campaigns to authenticated;
grant insert (workspace_id, audience_brief_id, platform, objective, name, budget_amount, budget_period) on public.ad_campaigns to authenticated;
grant update (name, objective, budget_amount, budget_period, status) on public.ad_campaigns to authenticated;

grant select on public.ad_creatives to authenticated;
grant insert (campaign_id, workspace_id, headline, body, call_to_action, image_ref) on public.ad_creatives to authenticated;

grant select on public.leads to authenticated;
grant insert (workspace_id, source, name, contact, notes, assigned_to, source_interaction_id) on public.leads to authenticated;
grant update (name, contact, status, notes, assigned_to) on public.leads to authenticated;

grant select on public.lead_activities to authenticated;
grant insert (lead_id, workspace_id, kind, body) on public.lead_activities to authenticated;

grant select on public.website_projects to authenticated;
grant insert (workspace_id, provider, title, pages) on public.website_projects to authenticated;
grant update (title, pages, status) on public.website_projects to authenticated;
