-- =====================================================================================
-- VMS Autopilot - Phase 1, migration 2 of 3: security functions, triggers, RLS
--
-- Run AFTER 20260928000100_foundation_schema.sql.
--
-- What this file does, in plain words:
--   * Decides who a person is inside a workspace (Admin / Team member / Client).
--   * Decides whether they may do something (allow / needs approval / deny).
--   * Locks every table with Row Level Security so the database itself refuses anything
--     the rules do not allow - even if the application code has a bug.
--   * Writes the audit log automatically and makes it impossible to edit or delete.
--   * Makes sure only an Admin can ever grant, revoke or change permissions.
-- =====================================================================================

-- ---------- Roles used by Supabase (exist already on a Supabase project) ---------------
-- anon           = not logged in            -> gets NOTHING
-- authenticated  = logged in via the app    -> gets only what RLS allows
-- service_role   = server-only key          -> bypasses RLS; never used in the browser

-- ---------- Helper functions (schema "private": not reachable through the API) ---------

-- A person's role inside a workspace. A direct membership wins; otherwise an agency
-- Admin/Team member reaches the client workspaces underneath their agency.
create or replace function private.role_of_user(p_user uuid, p_workspace uuid)
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select x.role
  from (
    select m.role
    from public.workspace_members m
    where m.workspace_id = p_workspace and m.user_id = p_user
    union all
    select m.role
    from public.workspaces w
    join public.workspace_members m on m.workspace_id = w.parent_workspace_id
    where w.id = p_workspace and w.kind = 'client' and m.user_id = p_user
  ) x
  where p_user is not null
  -- If someone holds more than one role here, the most powerful one wins.
  order by case x.role when 'admin' then 0 when 'team_member' then 1 else 2 end
  limit 1
$$;

create or replace function private.effective_role(p_workspace uuid)
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select private.role_of_user((select auth.uid()), p_workspace)
$$;

create or replace function private.is_admin(p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.effective_role(p_workspace) = 'admin', false)
$$;

-- The decision for the current user: 'allow', 'needs_approval' or 'deny'.
-- MUST stay identical to decide() in src/lib/permissions/policy.ts (a test compares them).
create or replace function private.action_decision(
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
  v_uid uuid := (select auth.uid());
  v_role public.member_role := private.role_of_user(v_uid, p_workspace);
  v_sensitive boolean;
  v_forced boolean;
begin
  if v_role is null then return 'deny'; end if;
  if v_role = 'admin' then return 'allow'; end if;

  -- Above the role's ceiling: no grant can ever unlock it.
  if not exists (
    select 1 from public.permission_ceiling c
    where c.role = v_role and c.module = p_module and c.action = p_action
  ) then
    return 'deny';
  end if;

  -- Must be a default for the role, or an active grant from an Admin.
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
        and (g.user_id = v_uid or (g.user_id is null and v_role = 'client'))
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

-- May the current user do this directly, right now? (sensitive actions => false for non-admins)
create or replace function private.can_do(
  p_workspace uuid, p_module public.permission_module, p_action public.permission_action
) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.action_decision(p_workspace, p_module, p_action) = 'allow' $$;

-- Does the current user hold this permission at all (even if it needs approval)?
create or replace function private.holds(
  p_workspace uuid, p_module public.permission_module, p_action public.permission_action
) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.action_decision(p_workspace, p_module, p_action) <> 'deny' $$;

-- Replace the value of any key that looks like a secret, at any depth.
-- Mirrors scrubSecrets() in src/lib/permissions/audit.ts.
create or replace function private.scrub_secrets(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  result jsonb;
begin
  if p is null then return null; end if;
  if jsonb_typeof(p) = 'object' then
    result := '{}'::jsonb;
    for k, v in select key, value from jsonb_each(p) loop
      if k ~* '(token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|bearer|credential|private[_-]?key|client[_-]?secret|refresh|cookie|session|jwt|dsn|signature)' then
        result := result || jsonb_build_object(k, '[redacted]'::text);
      else
        result := result || jsonb_build_object(k, private.scrub_secrets(v));
      end if;
    end loop;
    return result;
  elsif jsonb_typeof(p) = 'array' then
    return coalesce(
      (select jsonb_agg(private.scrub_secrets(e.value) order by e.ord)
       from jsonb_array_elements(p) with ordinality as e(value, ord)),
      '[]'::jsonb
    );
  elsif jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^(sk[-_][A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.|Bearer\s+\S+|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})' then
    return '"[redacted]"'::jsonb;
  end if;
  return p;
end;
$$;

-- ---------- Integrity triggers ----------------------------------------------------------

-- Workspaces: client workspaces must sit under an agency; kind/parent never change.
create or replace function private.trg_workspace_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.kind = 'client' and not exists (
      select 1 from public.workspaces p where p.id = new.parent_workspace_id and p.kind = 'agency'
    ) then
      raise exception 'a client workspace must belong to an agency workspace';
    end if;
    if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
  else
    if new.kind is distinct from old.kind or new.parent_workspace_id is distinct from old.parent_workspace_id then
      raise exception 'workspace kind and parent cannot be changed';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.trg_workspace_after_insert()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.workspace_settings (workspace_id) values (new.id);
  return new;
end;
$$;

-- Members: role must match the workspace kind; the last Admin can never be removed.
create or replace function private.trg_member_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_kind public.workspace_kind;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select w.kind into v_kind from public.workspaces w where w.id = new.workspace_id;
    if v_kind is null then raise exception 'workspace not found'; end if;
    if (new.role = 'client') <> (v_kind = 'client') then
      raise exception 'role % is not allowed in a % workspace', new.role, v_kind;
    end if;
  end if;

  if tg_op = 'UPDATE' and (new.workspace_id <> old.workspace_id or new.user_id <> old.user_id) then
    raise exception 'membership workspace and user cannot be changed';
  end if;

  if tg_op in ('UPDATE', 'DELETE') and old.role = 'admin'
     and (tg_op = 'DELETE' or new.role <> 'admin') then
    -- Lock the workspace's admin rows so two simultaneous removals cannot both pass.
    perform 1 from public.workspace_members m
      where m.workspace_id = old.workspace_id and m.role = 'admin' for update;
    if not exists (
      select 1 from public.workspace_members m
      where m.workspace_id = old.workspace_id and m.role = 'admin' and m.user_id <> old.user_id
    ) then
      raise exception 'cannot remove or demote the last admin of a workspace';
    end if;
  end if;

  if tg_op = 'INSERT' and (select auth.uid()) is not null then
    new.created_by := (select auth.uid());
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Grants: only on client workspaces, only within the role ceiling, never to an Admin,
-- and never edited afterwards - only revoked.
create or replace function private.trg_grant_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_kind public.workspace_kind;
  v_target public.member_role;
begin
  if tg_op = 'INSERT' then
    select w.kind into v_kind from public.workspaces w where w.id = new.workspace_id;
    if v_kind is distinct from 'client' then
      raise exception 'permissions are granted on client workspaces only';
    end if;

    if new.user_id is null then
      v_target := 'client';
    else
      v_target := private.role_of_user(new.user_id, new.workspace_id);
      if v_target is null then raise exception 'that person has no access to this workspace'; end if;
    end if;

    if v_target = 'admin' then raise exception 'an Admin already has every permission'; end if;

    if not exists (
      select 1 from public.permission_ceiling c
      where c.role = v_target and c.module = new.module and c.action = new.action
    ) then
      raise exception 'a % can never be given % on %', v_target, new.action, new.module;
    end if;

    if (select auth.uid()) is not null then new.granted_by := (select auth.uid()); end if;
    new.granted_at := now();
    new.revoked_at := null;
    new.revoked_by := null;
    return new;
  end if;

  -- UPDATE: revoke only.
  if new.workspace_id <> old.workspace_id
     or new.user_id is distinct from old.user_id
     or new.module <> old.module
     or new.action <> old.action
     or new.granted_by is distinct from old.granted_by
     or new.granted_at <> old.granted_at then
    raise exception 'a grant cannot be edited - revoke it and create a new one';
  end if;
  if old.revoked_at is not null then raise exception 'this grant is already revoked'; end if;
  if new.revoked_at is not null then
    new.revoked_at := now();
    if (select auth.uid()) is not null then new.revoked_by := (select auth.uid()); end if;
  end if;
  return new;
end;
$$;

-- Approval requests: created only for actions that really need approval; decided only
-- by an Admin (or cancelled by the person who asked); decisions are stamped by the server.
create or replace function private.trg_approval_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_decision text;
begin
  if tg_op = 'INSERT' then
    if v_uid is not null then
      v_decision := private.action_decision(new.workspace_id, new.module, new.action);
      if v_decision <> 'needs_approval' then
        raise exception 'this action does not need an approval request (decision: %)', v_decision;
      end if;
      new.requested_by := v_uid;
    end if;
    new.status := 'pending';
    new.decided_by := null;
    new.decided_at := null;
    new.created_at := now();
    return new;
  end if;

  -- UPDATE
  if new.workspace_id <> old.workspace_id
     or new.requested_by is distinct from old.requested_by
     or new.module <> old.module
     or new.action <> old.action
     or new.title <> old.title
     or new.details is distinct from old.details
     or new.created_at <> old.created_at then
    raise exception 'only the decision can be changed on an approval request';
  end if;
  if old.status <> 'pending' then raise exception 'this request has already been decided'; end if;
  -- Only an Admin may write a decision note - checked first, so it also covers a request
  -- that is still pending (otherwise a requester could pre-fill an "approved by Admin" note).
  if new.decision_note is distinct from old.decision_note
     and v_uid is not null and not private.is_admin(old.workspace_id) then
    raise exception 'only an Admin can write a decision note';
  end if;
  if new.status = 'pending' then return new; end if;

  if v_uid is not null then
    -- A logged-in person acting through the app.
    if new.status in ('approved', 'rejected') then
      if not private.is_admin(old.workspace_id) then
        raise exception 'only an Admin can approve or reject a request';
      end if;
    elsif new.status = 'cancelled' then
      if v_uid is distinct from old.requested_by then
        raise exception 'only the person who asked can cancel a request';
      end if;
    end if;
    if new.decision_note is distinct from old.decision_note and not private.is_admin(old.workspace_id) then
      raise exception 'only an Admin can write a decision note';
    end if;
    new.decided_by := v_uid;
  else
    -- The server acting for someone: it must say WHO decided, and an approval or
    -- rejection must be attributed to a real Admin of that workspace.
    if new.decided_by is null then
      raise exception 'a server-side decision must name the person who made it (decided_by)';
    end if;
    if new.status in ('approved', 'rejected')
       and private.role_of_user(new.decided_by, old.workspace_id) is distinct from 'admin' then
      raise exception 'decided_by must be an Admin of this workspace';
    end if;
  end if;
  new.decided_at := now();
  return new;
end;
$$;

create or replace function private.trg_settings_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := now();
  if (select auth.uid()) is not null then new.updated_by := (select auth.uid()); end if;
  return new;
end;
$$;

-- ---------- Audit log -------------------------------------------------------------------

-- Records changes to workspaces, members, grants, approvals, integrations and settings.
-- Denied attempts never reach the database, so the application records those itself.
create or replace function private.trg_audit()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_ws uuid;
  v_module public.permission_module;
  v_action text;
  v_target_type text := tg_table_name;
  v_target_id text;
  v_result public.audit_result := 'success';
  v_approval_id uuid;
  v_approval_status public.approval_status;
  v_meta jsonb;
  v_role text;
begin
  if tg_op = 'INSERT' then v_new := to_jsonb(new);
  elsif tg_op = 'UPDATE' then v_old := to_jsonb(old); v_new := to_jsonb(new);
  else v_old := to_jsonb(old);
  end if;
  v_row := coalesce(v_new, v_old);

  if tg_table_name = 'workspaces' then
    v_ws := (v_row ->> 'id')::uuid;
    v_module := 'clients';
    v_target_id := v_row ->> 'id';
    v_action := 'workspace.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  elsif tg_table_name = 'workspace_members' then
    v_ws := (v_row ->> 'workspace_id')::uuid;
    v_module := 'settings';
    v_target_id := v_row ->> 'user_id';
    v_action := case
      when tg_op = 'INSERT' then 'member.added'
      when tg_op = 'DELETE' then 'member.removed'
      when v_old ->> 'role' is distinct from v_new ->> 'role' then 'member.role_changed'
      else 'member.updated' end;
  elsif tg_table_name = 'permission_grants' then
    v_ws := (v_row ->> 'workspace_id')::uuid;
    v_module := (v_row ->> 'module')::public.permission_module;
    v_target_id := v_row ->> 'id';
    v_action := case
      when tg_op = 'INSERT' then 'permission.granted'
      when tg_op = 'UPDATE' and v_old ->> 'revoked_at' is null and v_new ->> 'revoked_at' is not null then 'permission.revoked'
      else 'permission.updated' end;
  elsif tg_table_name = 'approval_requests' then
    v_ws := (v_row ->> 'workspace_id')::uuid;
    v_module := (v_row ->> 'module')::public.permission_module;
    v_target_id := v_row ->> 'id';
    v_approval_id := (v_row ->> 'id')::uuid;
    v_approval_status := (v_row ->> 'status')::public.approval_status;
    if tg_op = 'INSERT' then
      v_action := 'approval.requested';
      v_result := 'pending_approval';
    else
      v_action := 'approval.' || (v_row ->> 'status');
    end if;
  elsif tg_table_name = 'integrations' then
    v_ws := (v_row ->> 'workspace_id')::uuid;
    v_module := 'integrations';
    v_target_id := v_row ->> 'id';
    v_action := 'integration.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'removed' end;
  else -- workspace_settings
    v_ws := (v_row ->> 'workspace_id')::uuid;
    v_module := 'settings';
    v_target_id := v_row ->> 'workspace_id';
    v_action := 'settings.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  end if;

  if tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(coalesce(o.key, n.key), jsonb_build_object('from', o.value, 'to', n.value)), '{}'::jsonb)
      into v_meta
    from jsonb_each(v_old) o
    full join jsonb_each(v_new) n on n.key = o.key
    where o.value is distinct from n.value;
    v_meta := jsonb_build_object('changed', v_meta);
  else
    v_meta := jsonb_build_object('row', v_row);
  end if;

  v_role := case when v_uid is null then 'system' else private.role_of_user(v_uid, v_ws)::text end;

  insert into public.audit_log (
    actor_id, actor_role, workspace_id, module, action, target_type, target_id,
    result, approval_id, approval_status, metadata
  ) values (
    v_uid, v_role, v_ws, v_module, v_action, v_target_type, v_target_id,
    v_result, v_approval_id, v_approval_status, private.scrub_secrets(v_meta)
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- The audit log can be added to but never changed or removed - not even by the service role.
create or replace function private.trg_audit_immutable()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'the audit log is append-only';
end;
$$;

-- ---------- New login => profile, and NO access -----------------------------------------

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 200), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------- Attach triggers -------------------------------------------------------------

create trigger workspaces_before before insert or update on public.workspaces
  for each row execute function private.trg_workspace_before();
create trigger workspaces_after_insert after insert on public.workspaces
  for each row execute function private.trg_workspace_after_insert();

create trigger workspace_members_before before insert or update or delete on public.workspace_members
  for each row execute function private.trg_member_before();

create trigger permission_grants_before before insert or update on public.permission_grants
  for each row execute function private.trg_grant_before();

create trigger approval_requests_before before insert or update on public.approval_requests
  for each row execute function private.trg_approval_before();

create trigger workspace_settings_before before update on public.workspace_settings
  for each row execute function private.trg_settings_before();

create trigger workspaces_audit after insert or update or delete on public.workspaces
  for each row execute function private.trg_audit();
create trigger workspace_members_audit after insert or update or delete on public.workspace_members
  for each row execute function private.trg_audit();
create trigger permission_grants_audit after insert or update or delete on public.permission_grants
  for each row execute function private.trg_audit();
create trigger approval_requests_audit after insert or update or delete on public.approval_requests
  for each row execute function private.trg_audit();
create trigger integrations_audit after insert or update or delete on public.integrations
  for each row execute function private.trg_audit();
create trigger workspace_settings_audit after insert or update or delete on public.workspace_settings
  for each row execute function private.trg_audit();

create trigger audit_log_no_change before update or delete on public.audit_log
  for each row execute function private.trg_audit_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function private.trg_audit_immutable();

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------- Row Level Security ----------------------------------------------------------

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
alter table public.integration_credentials enable row level security; -- no policies on purpose
alter table public.workspace_settings enable row level security;

-- profiles: your own row, plus people who belong to a workspace you administer.
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.workspace_members m
      where m.user_id = profiles.id and private.is_admin(m.workspace_id)
    )
  );
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- workspaces: you see only workspaces you belong to (or reach through your agency).
-- The second test looks at the row's own parent_workspace_id instead of re-reading the
-- workspaces table, so a workspace that was created a moment ago is visible to its creator
-- (needed for INSERT ... RETURNING).
create policy workspaces_select on public.workspaces for select to authenticated
  using (
    private.effective_role(id) is not null
    or private.effective_role(parent_workspace_id) is not null
  );
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (kind = 'client' and parent_workspace_id is not null and private.is_admin(parent_workspace_id));
create policy workspaces_update on public.workspaces for update to authenticated
  using (private.is_admin(id)) with check (private.is_admin(id));

-- workspace_members: you see yourself; Admins see and manage the people in their workspaces.
create policy members_select on public.workspace_members for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin(workspace_id));
create policy members_insert on public.workspace_members for insert to authenticated
  with check (private.is_admin(workspace_id));
create policy members_update on public.workspace_members for update to authenticated
  using (private.is_admin(workspace_id)) with check (private.is_admin(workspace_id));
create policy members_delete on public.workspace_members for delete to authenticated
  using (private.is_admin(workspace_id));

-- permission lookup tables: readable so the app can draw the permission editor; not writable.
create policy ceiling_select on public.permission_ceiling for select to authenticated using (true);
create policy defaults_select on public.permission_defaults for select to authenticated using (true);
create policy sensitive_select on public.permission_sensitive for select to authenticated using (true);

-- grants: only Admins write; a person can read what they themselves hold.
create policy grants_select on public.permission_grants for select to authenticated
  using (
    private.is_admin(workspace_id)
    or user_id = (select auth.uid())
    or (user_id is null and private.effective_role(workspace_id) = 'client')
  );
create policy grants_insert on public.permission_grants for insert to authenticated
  with check (private.is_admin(workspace_id));
create policy grants_update on public.permission_grants for update to authenticated
  using (private.is_admin(workspace_id)) with check (private.is_admin(workspace_id));

-- approval requests: the requester and Admins see them; the trigger enforces who may decide.
create policy approvals_select on public.approval_requests for select to authenticated
  using (
    private.is_admin(workspace_id)
    or (requested_by = (select auth.uid()) and private.effective_role(workspace_id) is not null)
  );
create policy approvals_insert on public.approval_requests for insert to authenticated
  with check (private.effective_role(workspace_id) is not null);
create policy approvals_update on public.approval_requests for update to authenticated
  using (
    private.is_admin(workspace_id)
    or (requested_by = (select auth.uid()) and private.effective_role(workspace_id) is not null)
  )
  with check (
    private.is_admin(workspace_id)
    or (requested_by = (select auth.uid()) and private.effective_role(workspace_id) is not null)
  );

-- audit log: Admins read their own workspaces' history. Nobody can write to it directly.
create policy audit_select on public.audit_log for select to authenticated
  using (workspace_id is not null and private.is_admin(workspace_id));

-- integrations: status only. Admins (and team members an Admin has allowed) can look;
-- only a directly-allowed manager can change. Clients never see this table.
create policy integrations_select on public.integrations for select to authenticated
  using (private.holds(workspace_id, 'integrations', 'view'));
create policy integrations_insert on public.integrations for insert to authenticated
  with check (private.can_do(workspace_id, 'integrations', 'manage_integration'));
create policy integrations_update on public.integrations for update to authenticated
  using (private.can_do(workspace_id, 'integrations', 'manage_integration'))
  with check (private.can_do(workspace_id, 'integrations', 'manage_integration'));
create policy integrations_delete on public.integrations for delete to authenticated
  using (private.can_do(workspace_id, 'integrations', 'manage_integration'));

-- workspace settings: Admin only.
create policy settings_select on public.workspace_settings for select to authenticated
  using (private.is_admin(workspace_id));
create policy settings_update on public.workspace_settings for update to authenticated
  using (private.is_admin(workspace_id)) with check (private.is_admin(workspace_id));

-- ---------- Privileges (second lock, underneath RLS) ------------------------------------

-- Supabase hands new tables generous default privileges. Take them all away, then give
-- back only what the app needs. anon (not logged in) gets nothing at all.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant select, update (full_name) on public.profiles to authenticated;
-- created_by is internal: list columns explicitly (select * is refused on purpose).
grant select (id, kind, parent_workspace_id, name, industry, archived_at, created_at) on public.workspaces to authenticated;
grant insert (kind, parent_workspace_id, name, industry), update (name, industry, archived_at)
  on public.workspaces to authenticated;
grant select, insert (workspace_id, user_id, role), update (role), delete on public.workspace_members to authenticated;
grant select on public.permission_ceiling, public.permission_defaults, public.permission_sensitive to authenticated;
-- note / granted_by / revoked_by are Admin-internal and are NOT readable through the app's API
-- (the audit log records who granted what). An Admin-only view can expose them in Phase 2.
grant select (id, workspace_id, user_id, module, action, granted_at, revoked_at) on public.permission_grants to authenticated;
grant insert (workspace_id, user_id, module, action, note), update (revoked_at)
  on public.permission_grants to authenticated;
grant select, insert (workspace_id, module, action, title, details), update (status, decision_note)
  on public.approval_requests to authenticated;
grant select on public.audit_log to authenticated;
-- Status and the consent record (consent_*, connected_at, last_checked_at) are written only by
-- the server when an OAuth connection really completes, so a user cannot forge them.
grant select,
  insert (workspace_id, provider, display_name, external_account_label),
  update (display_name, external_account_label),
  delete
  on public.integrations to authenticated;
-- integration_credentials: nothing for anon/authenticated. Service role only.
grant select, update (approval_policy, ad_spend_monthly_cap) on public.workspace_settings to authenticated;

-- The audit log is append-only for everyone, including the server-side service role.
revoke update, delete, truncate on public.audit_log from anon, authenticated, service_role;

-- The permission rules change only through migrations (generated from the TypeScript policy),
-- never through an API key - not even the server's.
revoke insert, update, delete, truncate on
  public.permission_ceiling, public.permission_defaults, public.permission_sensitive
  from anon, authenticated, service_role;

-- Helper functions: nobody can call them by accident. Only the few that RLS policies
-- evaluate directly are opened to logged-in users.
alter default privileges in schema private revoke execute on functions from public;
revoke execute on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function
  private.effective_role(uuid),
  private.is_admin(uuid),
  private.can_do(uuid, public.permission_module, public.permission_action),
  private.holds(uuid, public.permission_module, public.permission_action)
  to authenticated;
