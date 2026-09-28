-- =====================================================================================
-- VMS Autopilot - Runtime-Agent Phase, Sub-phase A: AI Orchestrator skeleton (SANDBOX ONLY)
--
-- Run AFTER migrations 0100-0600. Adds ONLY new tables and new functions - nothing here
-- changes any existing table, enum, policy, trigger or seed from Phases 1-4.
--
-- What this file does, in plain words:
--   * agent_definitions - one row per configured agent (its instructions, tools and model),
--     always sitting under an AGENCY workspace, so one agency configures its agents once and
--     reuses them across every one of its clients. Only that agency's Admin can see or change
--     one - nobody else, ever.
--   * agent_runs / agent_handoffs / agent_tool_calls - the execution log: every time an agent
--     is asked to do something, every tool it tries to use, and every time one agent's result
--     is handed to another agent to continue. Visible only to the Admin of the workspace the
--     run was for - exactly as private as the existing audit log, and just as append-only.
--   * private.action_decision_for(...) - the same rule private.action_decision() already
--     applies for a *logged-in* person, made usable for a person an agent is acting *on
--     behalf of*. Every tool call that maps to a permission is checked against this before it
--     can be written, so even a bug in the application layer cannot record an agent as more
--     permitted than the human who enabled it - the database itself refuses that row.
--   * The only agent that exists after this migration is 'sandbox_echo' - a scripted,
--     deterministic stand-in with no AI call, no key and no network access, used to prove the
--     whole pipeline (routing, permission checks, approvals, audit trail, tenant isolation)
--     end to end before any real agent is built. The real nine agents from
--     docs/AGENT-RUNTIME-ARCHITECTURE.md are added one at a time in later sub-phases.
-- =====================================================================================

-- ---------- Tables ----------------------------------------------------------------------

create table public.agent_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_key text not null check (agent_key ~ '^[a-z0-9_]{2,60}$'),
  display_name text not null check (char_length(display_name) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  model text not null default 'sandbox-echo' check (char_length(model) between 1 and 80),
  system_prompt text not null default '' check (char_length(system_prompt) <= 20000),
  allowed_tools jsonb not null default '[]'::jsonb check (jsonb_typeof(allowed_tools) = 'array'),
  enabled boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, agent_key)
);

-- One row per time the Orchestrator asks an agent to do something.
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_definition_id uuid references public.agent_definitions (id) on delete set null,
  -- Copied at creation so history still reads even if the definition is later removed.
  agent_key text not null check (agent_key ~ '^[a-z0-9_]{2,60}$'),
  triggered_by uuid references auth.users (id) on delete set null,
  triggered_by_kind text not null default 'user' check (triggered_by_kind in ('user', 'system', 'agent')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'needs_approval', 'cancelled')),
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object' and octet_length(input::text) < 20000),
  output jsonb check (output is null or (jsonb_typeof(output) = 'object' and octet_length(output::text) < 20000)),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_run_finished_consistent check (
    (status in ('queued', 'running') and finished_at is null)
    or (status not in ('queued', 'running') and finished_at is not null)
  )
);
create index agent_runs_ws_idx on public.agent_runs (workspace_id, started_at desc);
create index agent_runs_definition_idx on public.agent_runs (agent_definition_id);

-- One row per time one agent's output is handed to another agent to continue the work.
create table public.agent_handoffs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  from_run_id uuid not null references public.agent_runs (id) on delete cascade,
  to_agent_key text not null check (to_agent_key ~ '^[a-z0-9_]{2,60}$'),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) < 20000),
  resolved_run_id uuid references public.agent_runs (id) on delete set null,
  created_at timestamptz not null default now()
);
create index agent_handoffs_from_idx on public.agent_handoffs (from_run_id);
create index agent_handoffs_ws_idx on public.agent_handoffs (workspace_id, created_at desc);

-- One row per tool an agent actually tried to use. A pure utility tool (no permission
-- attached, e.g. the echo demo's own "repeat this text" tool) leaves on_behalf_of, module,
-- action and decision all NULL. Anything that maps to a real permission must carry all four.
create table public.agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  tool_name text not null check (tool_name ~ '^[a-z0-9_]{2,80}$'),
  tool_input jsonb not null default '{}'::jsonb check (jsonb_typeof(tool_input) = 'object' and octet_length(tool_input::text) < 20000),
  tool_output jsonb check (tool_output is null or (jsonb_typeof(tool_output) = 'object' and octet_length(tool_output::text) < 20000)),
  -- The human whose role/grants were actually checked. An agent can never be recorded as
  -- more permitted than this person - private.action_decision_for() proves it below.
  on_behalf_of uuid references auth.users (id) on delete set null,
  module public.permission_module,
  action public.permission_action,
  decision text check (decision in ('allow', 'deny', 'needs_approval')),
  approval_id uuid references public.approval_requests (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint agent_tool_call_decision_shape check (
    (module is null and action is null and decision is null and on_behalf_of is null and approval_id is null)
    or (module is not null and action is not null and decision is not null and on_behalf_of is not null)
  )
);
create index agent_tool_calls_run_idx on public.agent_tool_calls (run_id);
create index agent_tool_calls_ws_idx on public.agent_tool_calls (workspace_id, created_at desc);

alter table public.agent_definitions enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_handoffs enable row level security;
alter table public.agent_tool_calls enable row level security;

-- ---------- Helpers -----------------------------------------------------------------------

-- True if this agent definition may be used for this workspace: it is the definition's own
-- agency, or the definition governs a client workspace that sits under that same agency.
create or replace function private.agent_definition_governs_workspace(p_definition_id uuid, p_workspace uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.agent_definitions d
    join public.workspaces w on w.id = p_workspace
    where d.id = p_definition_id
      and (d.workspace_id = p_workspace or d.workspace_id = w.parent_workspace_id)
  )
$$;

-- The same rule as private.action_decision() (migration 20260928000200), but for a named
-- person instead of the currently logged-in one - so the server can check "what would THIS
-- person be allowed to do", which is exactly what an agent acting on someone's behalf needs.
-- Deliberately mirrors action_decision()'s body; keep the two in sync if either ever changes.
create or replace function private.action_decision_for(
  p_uid uuid,
  p_workspace uuid,
  p_module public.permission_module,
  p_action public.permission_action
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.member_role := private.role_of_user(p_uid, p_workspace);
  v_sensitive boolean;
  v_forced boolean;
begin
  if v_role is null then return 'deny'; end if;
  if v_role = 'admin' then return 'allow'; end if;

  if not exists (
    select 1 from public.permission_ceiling c
    where c.role = v_role and c.module = p_module and c.action = p_action
  ) then
    return 'deny';
  end if;

  if not (
    exists (
      select 1 from public.permission_defaults d
      where d.role = v_role and d.module = p_module and d.action = p_action
    )
    or exists (
      select 1 from public.permission_grants g
      where g.workspace_id = p_workspace
        and g.module = p_module
        and g.action = p_action
        and g.revoked_at is null
        and (g.user_id = p_uid or (g.user_id is null and v_role = 'client'))
    )
  ) then
    return 'deny';
  end if;

  select exists (
    select 1 from public.permission_sensitive s where s.module = p_module and s.action = p_action
  ) into v_sensitive;

  select exists (
    select 1
    from public.workspace_settings ws,
         lateral jsonb_array_elements_text(ws.approval_policy) as e(pair)
    where ws.workspace_id = p_workspace
      and e.pair = p_module::text || ':' || p_action::text
  ) into v_forced;

  if v_sensitive or v_forced then return 'needs_approval'; end if;
  return 'allow';
end;
$$;

-- ---------- Integrity triggers -------------------------------------------------------------

create or replace function private.trg_agent_definition_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.workspaces w where w.id = new.workspace_id and w.kind = 'agency') then
      raise exception 'agents are configured on an agency workspace, then reused across its clients';
    end if;
    if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
  else
    if new.workspace_id <> old.workspace_id or new.agent_key <> old.agent_key then
      raise exception 'a definition''s workspace and agent_key cannot be changed';
    end if;
  end if;
  if (select auth.uid()) is not null then new.updated_by := (select auth.uid()); end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.trg_agent_run_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.agent_definition_id is not null
       and not private.agent_definition_governs_workspace(new.agent_definition_id, new.workspace_id) then
      raise exception 'that agent is not configured for this workspace';
    end if;
  else
    if new.workspace_id <> old.workspace_id or new.agent_definition_id is distinct from old.agent_definition_id
       or new.agent_key <> old.agent_key or new.triggered_by is distinct from old.triggered_by
       or new.triggered_by_kind <> old.triggered_by_kind or new.input is distinct from old.input
       or new.started_at <> old.started_at then
      raise exception 'a run''s identity and starting facts cannot be changed - only its outcome';
    end if;
    if old.status not in ('queued', 'running') and new.status <> old.status then
      raise exception 'a run that already finished (%) cannot change status', old.status;
    end if;
  end if;
  new.input := private.scrub_secrets(new.input);
  new.output := private.scrub_secrets(new.output);
  return new;
end;
$$;

create or replace function private.trg_agent_handoff_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.agent_runs;
begin
  if tg_op = 'INSERT' then
    select * into v_run from public.agent_runs r where r.id = new.from_run_id;
    if not found or v_run.workspace_id <> new.workspace_id then
      raise exception 'that run does not belong to this workspace';
    end if;
    new.payload := private.scrub_secrets(new.payload);
    return new;
  end if;
  if new.workspace_id <> old.workspace_id or new.from_run_id <> old.from_run_id
     or new.to_agent_key <> old.to_agent_key or new.payload is distinct from old.payload then
    raise exception 'a handoff cannot be edited - only marked resolved';
  end if;
  return new;
end;
$$;

create or replace function private.trg_agent_tool_call_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.agent_runs;
  v_expected text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'a tool call record cannot be changed once written';
  end if;

  select * into v_run from public.agent_runs r where r.id = new.run_id;
  if not found or v_run.workspace_id <> new.workspace_id then
    raise exception 'that run does not belong to this workspace';
  end if;

  if new.module is not null then
    v_expected := private.action_decision_for(new.on_behalf_of, new.workspace_id, new.module, new.action);
    if new.decision <> v_expected then
      raise exception 'this tool call''s recorded decision (%) does not match what permission rules actually allow (%) for that person - an agent can never be recorded as more permitted than the human it acted for', new.decision, v_expected;
    end if;
    if new.decision = 'needs_approval' then
      if new.approval_id is null then
        raise exception 'a tool call that needs approval must reference the approval request that was created for it';
      end if;
      if not exists (
        select 1 from public.approval_requests a
        where a.id = new.approval_id and a.workspace_id = new.workspace_id
          and a.module = new.module and a.action = new.action
      ) then
        raise exception 'the referenced approval request does not match this tool call''s workspace, module and action';
      end if;
    elsif new.approval_id is not null then
      raise exception 'only a tool call that needs approval may reference an approval request';
    end if;
  end if;

  new.tool_input := private.scrub_secrets(new.tool_input);
  new.tool_output := private.scrub_secrets(new.tool_output);
  return new;
end;
$$;

create trigger agent_definitions_before before insert or update on public.agent_definitions
  for each row execute function private.trg_agent_definition_before();
create trigger agent_runs_before before insert or update on public.agent_runs
  for each row execute function private.trg_agent_run_before();
create trigger agent_handoffs_before before insert or update on public.agent_handoffs
  for each row execute function private.trg_agent_handoff_before();
create trigger agent_tool_calls_before before insert or update on public.agent_tool_calls
  for each row execute function private.trg_agent_tool_call_before();

-- ---------- Audit trail ---------------------------------------------------------------------

-- Every run, handoff and tool call is written to the SAME audit_log every human action
-- already goes to - an agent does not get a quieter trail than a person would.
create or replace function private.trg_audit_agents()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_action text;
  v_meta jsonb;
  v_result public.audit_result := 'success';
  v_approval uuid := null;
begin
  if tg_table_name = 'agent_definitions' then
    v_action := case tg_op when 'INSERT' then 'agent.definition_created' else 'agent.definition_updated' end;
    v_meta := jsonb_build_object('agent_key', new.agent_key, 'enabled', new.enabled, 'model', new.model);
  elsif tg_table_name = 'agent_runs' then
    v_action := case when tg_op = 'INSERT' then 'agent.run_started' else 'agent.run_' || new.status end;
    if new.status = 'failed' then v_result := 'failed'; end if;
    if new.status = 'needs_approval' then v_result := 'pending_approval'; end if;
    v_meta := jsonb_build_object('agent_key', new.agent_key, 'run_id', new.id, 'triggered_by_kind', new.triggered_by_kind);
  elsif tg_table_name = 'agent_tool_calls' then
    v_action := 'agent.tool_called';
    v_meta := jsonb_build_object('run_id', new.run_id, 'tool_name', new.tool_name, 'module', new.module, 'action', new.action, 'decision', new.decision);
    if new.decision = 'deny' then v_result := 'denied'; end if;
    if new.decision = 'needs_approval' then v_result := 'pending_approval'; v_approval := new.approval_id; end if;
  else -- agent_handoffs
    v_action := 'agent.handoff_created';
    v_meta := jsonb_build_object('from_run_id', new.from_run_id, 'to_agent_key', new.to_agent_key);
  end if;

  insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, approval_id, metadata)
  values (null, 'agent', new.workspace_id, null, v_action, tg_table_name, new.id::text, v_result, v_approval, private.scrub_secrets(v_meta));
  return new;
end;
$$;

create trigger agent_definitions_audit after insert or update on public.agent_definitions
  for each row execute function private.trg_audit_agents();
create trigger agent_runs_audit after insert or update on public.agent_runs
  for each row execute function private.trg_audit_agents();
create trigger agent_handoffs_audit after insert on public.agent_handoffs
  for each row execute function private.trg_audit_agents();
create trigger agent_tool_calls_audit after insert on public.agent_tool_calls
  for each row execute function private.trg_audit_agents();

-- ---------- Row Level Security ----------------------------------------------------------

-- Config: only the Admin of the agency workspace it lives on.
create policy agent_definitions_select on public.agent_definitions for select to authenticated
  using (private.is_admin(workspace_id));
create policy agent_definitions_insert on public.agent_definitions for insert to authenticated
  with check (private.is_admin(workspace_id));
create policy agent_definitions_update on public.agent_definitions for update to authenticated
  using (private.is_admin(workspace_id)) with check (private.is_admin(workspace_id));
create policy agent_definitions_delete on public.agent_definitions for delete to authenticated
  using (private.is_admin(workspace_id));

-- Execution log: Admin-only read, exactly as private as the audit log. Nobody writes these
-- through the app's own key - only the server (the Orchestrator, using service_role) does.
create policy agent_runs_select on public.agent_runs for select to authenticated
  using (private.is_admin(workspace_id));
create policy agent_handoffs_select on public.agent_handoffs for select to authenticated
  using (private.is_admin(workspace_id));
create policy agent_tool_calls_select on public.agent_tool_calls for select to authenticated
  using (private.is_admin(workspace_id));

-- ---------- Privileges ------------------------------------------------------------------

revoke all on public.agent_definitions, public.agent_runs, public.agent_handoffs, public.agent_tool_calls
  from anon, authenticated;

grant select on public.agent_definitions to authenticated;
grant insert (workspace_id, agent_key, display_name, description, model, system_prompt, allowed_tools, enabled)
  on public.agent_definitions to authenticated;
grant update (display_name, description, model, system_prompt, allowed_tools, enabled) on public.agent_definitions to authenticated;
grant delete on public.agent_definitions to authenticated;

-- Execution tables: read-only through the app's own key. Only the server's own service-role
-- key inserts and updates these - never the browser, never a Client, never an Admin's key.
grant select on public.agent_runs, public.agent_handoffs, public.agent_tool_calls to authenticated;
revoke insert, update, delete, truncate on public.agent_runs, public.agent_handoffs, public.agent_tool_calls
  from anon, authenticated;

-- History is kept, not edited - even the server cannot delete it (mirrors the audit log rule).
revoke delete, truncate on public.agent_runs, public.agent_handoffs, public.agent_tool_calls from service_role;
