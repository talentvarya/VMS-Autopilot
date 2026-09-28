-- =====================================================================================
-- VMS Autopilot - Phase 1, migration 1 of 3: foundation schema
--
-- Creates: enums, profiles, workspaces, members, permission tables, approvals,
--          audit log, integrations (+ locked credentials table), workspace settings.
-- Run order: 1) this file  2) ..._security_functions_and_rls.sql  3) ..._permission_seed.sql
--
-- Nothing here connects to any external account or contains any secret.
-- Paste-and-run in the Supabase SQL editor of a TEST project first.
-- =====================================================================================

-- Helper functions live in a schema that the Supabase API does not expose.
create schema if not exists private;

-- ---------- Types ---------------------------------------------------------------------

create type public.member_role as enum ('admin', 'team_member', 'client');
create type public.workspace_kind as enum ('agency', 'client');

-- Keep these lists identical to src/lib/permissions/types.ts (a test enforces it).
create type public.permission_module as enum (
  'seo_geo', 'paid_ads', 'domains', 'website', 'ai_assistant', 'social', 'leads_crm',
  'reports', 'billing', 'change_requests', 'integrations', 'approvals', 'audit_log',
  'health_monitor', 'settings', 'clients'
);
create type public.permission_action as enum (
  'view', 'create', 'edit', 'approve', 'publish_execute', 'delete', 'billing',
  'manage_integration', 'grant_permission'
);
create type public.approval_status as enum ('pending', 'approved', 'rejected', 'cancelled');
create type public.audit_result as enum ('success', 'denied', 'failed', 'pending_approval');
create type public.integration_status as enum ('not_connected', 'connected', 'expired', 'error');

-- ---------- People ----------------------------------------------------------------------

-- One row per login. Created automatically when someone signs up; signing up grants
-- NO access to anything - an Admin must add the person to a workspace.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text check (full_name is null or char_length(full_name) <= 200),
  created_at timestamptz not null default now()
);

-- ---------- Workspaces ------------------------------------------------------------------

-- 'agency' = the agency's own workspace (Admins and team members live here).
-- 'client' = one per client business, always the child of exactly one agency.
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  kind public.workspace_kind not null,
  parent_workspace_id uuid references public.workspaces (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  industry text check (industry is null or char_length(industry) <= 120),
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint workspace_parent_rule check (
    (kind = 'agency' and parent_workspace_id is null)
    or (kind = 'client' and parent_workspace_id is not null)
  )
);
create index workspaces_parent_idx on public.workspaces (parent_workspace_id);

-- admin / team_member belong to agency workspaces; client belongs to client workspaces.
-- (A trigger in migration 2 enforces that pairing.)
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

-- ---------- Permissions -----------------------------------------------------------------

-- Lookup tables, filled by 20260928000300_permission_seed.sql (generated from TypeScript).
create table public.permission_ceiling (
  role public.member_role not null,
  module public.permission_module not null,
  action public.permission_action not null,
  primary key (role, module, action)
);
create table public.permission_defaults (
  role public.member_role not null,
  module public.permission_module not null,
  action public.permission_action not null,
  primary key (role, module, action)
);
create table public.permission_sensitive (
  module public.permission_module not null,
  action public.permission_action not null,
  primary key (module, action)
);

-- Grants an Admin gives on a CLIENT workspace. user_id NULL = every client-role user of
-- that workspace. Grants are never deleted - they are revoked, so history is kept.
create table public.permission_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  module public.permission_module not null,
  action public.permission_action not null,
  note text check (note is null or char_length(note) <= 500),
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz
);
create unique index permission_grants_active_uniq
  on public.permission_grants (
    workspace_id,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    module,
    action
  )
  where revoked_at is null;
create index permission_grants_lookup_idx on public.permission_grants (workspace_id, user_id) where revoked_at is null;

-- ---------- Approvals -------------------------------------------------------------------

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  module public.permission_module not null,
  action public.permission_action not null,
  title text not null check (char_length(title) between 1 and 200),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and octet_length(details::text) < 20000),
  status public.approval_status not null default 'pending',
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  created_at timestamptz not null default now(),
  constraint approval_decided_consistent check (
    (status = 'pending' and decided_at is null) or (status <> 'pending' and decided_at is not null)
  )
);
create index approval_requests_ws_status_idx on public.approval_requests (workspace_id, status, created_at desc);

-- ---------- Audit log -------------------------------------------------------------------

-- Append-only. No foreign keys on purpose: history must survive deleted users/workspaces.
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_role text,
  workspace_id uuid,
  module public.permission_module,
  action text not null check (char_length(action) between 1 and 120),
  target_type text,
  target_id text,
  result public.audit_result not null default 'success',
  approval_id uuid,
  approval_status public.approval_status,
  metadata jsonb not null default '{}'::jsonb
);
create index audit_log_ws_at_idx on public.audit_log (workspace_id, at desc);
create index audit_log_actor_idx on public.audit_log (actor_id, at desc);

-- ---------- Integrations ----------------------------------------------------------------

-- Connection STATUS only - safe to show to Admins. Tokens/keys are never stored here.
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  display_name text check (display_name is null or char_length(display_name) <= 120),
  external_account_label text check (external_account_label is null or char_length(external_account_label) <= 200),
  status public.integration_status not null default 'not_connected',
  -- Consent and authorization record for every external account (PRD 5.1).
  consent_given_by uuid references auth.users (id) on delete set null,
  consent_recorded_at timestamptz,
  consent_version text,
  connected_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint integration_connected_needs_consent check (
    status <> 'connected' or (consent_recorded_at is not null and consent_given_by is not null)
  )
);
create unique index integrations_unique_account
  on public.integrations (workspace_id, provider, coalesce(external_account_label, ''));

-- The ONLY place a reference to a secret lives. secret_ref points at a Supabase Vault
-- secret (or another secret manager) - never the token itself. Row Level Security is on
-- with no policies and every browser-facing role is revoked, so only the server-side
-- service role can touch it. Clients can never read it.
create table public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null unique references public.integrations (id) on delete cascade,
  secret_ref text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

-- ---------- Workspace settings ----------------------------------------------------------

create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  -- Extra "module:action" pairs an Admin wants forced through approval, e.g. ["paid_ads:edit"].
  approval_policy jsonb not null default '[]'::jsonb check (jsonb_typeof(approval_policy) = 'array'),
  -- Configurable per-client ad spend limit (PRD 5.6). NULL = no cap set yet.
  ad_spend_monthly_cap numeric(12, 2) check (ad_spend_monthly_cap is null or ad_spend_monthly_cap >= 0),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ---------- Lock everything immediately ---------------------------------------------------
-- Supabase gives new tables generous default access. Close it now, so there is no window
-- between running this file and the next one. (Migration 2 adds the precise rules.)
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.permission_ceiling enable row level security;
alter table public.permission_defaults enable row level security;
alter table public.permission_sensitive enable row level security;
alter table public.permission_grants enable row level security;
alter table public.approval_requests enable row level security;
alter table public.audit_log enable row level security;
alter table public.integrations enable row level security;
alter table public.integration_credentials enable row level security;
alter table public.workspace_settings enable row level security;
revoke all on all tables in schema public from anon, authenticated;
