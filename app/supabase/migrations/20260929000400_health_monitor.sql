-- =====================================================================================
-- VMS Autopilot - Runtime-Agent Phase, Sub-phase D: Monitoring/Auto-Repair (SANDBOX ONLY)
--
-- Run AFTER migration 20260929000300_content_agent.sql. Adds ONLY two new tables and new
-- functions - nothing here changes any existing table, enum, policy or trigger from Phases
-- 1-4 or Sub-phases A/B/C. In particular audit_runs, social_posts and their own triggers are
-- completely untouched: the safe repairs this phase performs go through the EXISTING,
-- unmodified failStaleRuns() (Phase 2) and failStalePublishing() (Phase 3) functions.
--
-- The Analytics/Reporting Agent (Sub-phase D's other half) needs NO schema of its own at all:
-- it is read-only by design and is fed already-authorized data as input - it never queries
-- the database itself. See app/src/lib/agents/analytics/agent.ts.
--
-- What this file adds, in plain words:
--   * health_checks - one row per check the Monitoring Agent runs (pass or fail).
--   * health_incidents - opened only when a check fails; records whether a safe repair was
--     attempted and what happened, and can be closed once resolved.
--   * Both reuse the EXISTING 'health_monitor' permission module - which Phase 1 already made
--     Admin-only by CEILING (ADMIN_ONLY_MODULES already includes it): no non-admin role can
--     ever hold any action on this module, with or without a grant. No new permission module
--     or action is added anywhere in this file.
-- =====================================================================================

create type public.health_check_status as enum ('pass', 'fail');

create table public.health_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  check_type text not null check (check_type ~ '^[a-z0-9_]{2,60}$'),
  status public.health_check_status not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and octet_length(details::text) < 10000),
  checked_at timestamptz not null default now(),
  checked_by uuid references auth.users (id) on delete set null
);
create index health_checks_ws_idx on public.health_checks (workspace_id, checked_at desc);

create table public.health_incidents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  check_type text not null check (check_type ~ '^[a-z0-9_]{2,60}$'),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  auto_repair_attempted boolean not null default false,
  auto_repair_action text check (auto_repair_action is null or char_length(auto_repair_action) <= 80),
  auto_repair_result jsonb not null default '{}'::jsonb check (jsonb_typeof(auto_repair_result) = 'object'),
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  constraint health_incident_closed_consistent check (
    (closed_at is null) or (closed_at is not null and resolved_at is not null)
  )
);
create index health_incidents_ws_idx on public.health_incidents (workspace_id, opened_at desc);
create index health_incidents_open_idx on public.health_incidents (workspace_id) where closed_at is null;

alter table public.health_checks enable row level security;
alter table public.health_incidents enable row level security;

-- ---------- Integrity triggers -------------------------------------------------------------

create or replace function private.trg_health_check_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  new.checked_at := now();
  if (select auth.uid()) is not null then new.checked_by := (select auth.uid()); end if;
  return new;
end;
$$;

create or replace function private.trg_health_incident_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.opened_at := now();
    new.closed_at := null; new.resolved_by := null; new.resolved_at := null;
    return new;
  end if;
  if new.workspace_id <> old.workspace_id or new.check_type <> old.check_type or new.opened_at <> old.opened_at then
    raise exception 'an incident''s workspace, check type and open time cannot be changed';
  end if;
  if old.closed_at is not null then raise exception 'this incident is already closed'; end if;
  if new.closed_at is not null then
    new.closed_at := now();
    if (select auth.uid()) is not null then new.resolved_by := (select auth.uid()); end if;
    new.resolved_at := now();
  end if;
  return new;
end;
$$;

create trigger health_checks_before before insert on public.health_checks
  for each row execute function private.trg_health_check_before();
create trigger health_incidents_before before insert or update on public.health_incidents
  for each row execute function private.trg_health_incident_before();

-- ---------- Audit trail ---------------------------------------------------------------------

create or replace function private.trg_audit_health_monitor()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_action text;
  v_meta jsonb;
  v_result public.audit_result := 'success';
begin
  if tg_table_name = 'health_checks' then
    v_action := 'health.check_' || new.status::text;
    v_meta := jsonb_build_object('check_type', new.check_type, 'status', new.status, 'details', new.details);
    if new.status = 'fail' then v_result := 'failed'; end if;
  else -- health_incidents
    v_action := case
      when tg_op = 'INSERT' then 'health.incident_opened'
      when new.closed_at is not null and old.closed_at is null then 'health.incident_closed'
      else 'health.incident_updated'
    end;
    v_meta := jsonb_build_object('check_type', new.check_type, 'auto_repair_attempted', new.auto_repair_attempted, 'auto_repair_action', new.auto_repair_action, 'auto_repair_result', new.auto_repair_result);
  end if;

  insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, metadata)
  values (v_uid, case when v_uid is null then 'system' else private.role_of_user(v_uid, new.workspace_id)::text end, new.workspace_id, 'health_monitor', v_action, tg_table_name, new.id::text, v_result, private.scrub_secrets(v_meta));
  return new;
end;
$$;

create trigger health_checks_audit after insert on public.health_checks
  for each row execute function private.trg_audit_health_monitor();
create trigger health_incidents_audit after insert or update on public.health_incidents
  for each row execute function private.trg_audit_health_monitor();

-- ---------- Row Level Security ----------------------------------------------------------

create policy health_checks_select on public.health_checks for select to authenticated
  using (private.can_do(workspace_id, 'health_monitor', 'view'));
create policy health_checks_insert on public.health_checks for insert to authenticated
  with check (private.can_do(workspace_id, 'health_monitor', 'create'));

create policy health_incidents_select on public.health_incidents for select to authenticated
  using (private.can_do(workspace_id, 'health_monitor', 'view'));
create policy health_incidents_insert on public.health_incidents for insert to authenticated
  with check (private.can_do(workspace_id, 'health_monitor', 'create'));
create policy health_incidents_update on public.health_incidents for update to authenticated
  using (private.can_do(workspace_id, 'health_monitor', 'edit')) with check (private.can_do(workspace_id, 'health_monitor', 'edit'));

-- ---------- Privileges ------------------------------------------------------------------

revoke all on public.health_checks, public.health_incidents from anon, authenticated;
grant select on public.health_checks to authenticated;
grant insert (workspace_id, check_type, status, details) on public.health_checks to authenticated;
grant select on public.health_incidents to authenticated;
grant insert (workspace_id, check_type, auto_repair_attempted, auto_repair_action, auto_repair_result) on public.health_incidents to authenticated;
grant update (closed_at, auto_repair_attempted, auto_repair_action, auto_repair_result) on public.health_incidents to authenticated;

-- History is kept, not erased - not even by the server, same rule as audit_log and agent_runs.
revoke delete, truncate on public.health_checks, public.health_incidents from service_role;
