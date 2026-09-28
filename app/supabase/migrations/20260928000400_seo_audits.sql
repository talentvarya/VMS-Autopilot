-- =====================================================================================
-- VMS Autopilot - Phase 2, migration 4: SEO / GEO audits
--
-- Run AFTER the three Phase 1 migrations. Nothing here contacts any website.
--
-- The rule this file enforces (PRD 5.4): a Client can VIEW and RUN audits and download
-- reports, but can never change a website or apply a fix.
--   * A Client may ask for a run (a "queued" row). Nothing else.
--   * Results (scores, findings) are written only by the server (service role).
--   * Findings can never be edited, except that an Admin can record that a fix was applied.
--   * Live runs cannot be requested from the app at all; only sample runs.
--   * Runs are rate-limited so nobody can run up cost or flood the log.
-- =====================================================================================

create type public.audit_run_status as enum ('queued', 'running', 'completed', 'failed');
create type public.audit_source as enum ('fixture', 'live');
create type public.finding_severity as enum ('critical', 'high', 'medium', 'low', 'info', 'pass');
create type public.finding_category as enum ('technical', 'onpage', 'mobile', 'performance', 'local', 'geo');
create type public.fix_status as enum ('open', 'applied', 'wont_fix');

-- ---------- Tables ----------------------------------------------------------------------

-- A website that belongs to a client workspace.
create table public.sites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Lower-case web address with a dotted website name, no path. No IP addresses, no "localhost".
  origin text not null check (
    origin ~ '^https?://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[0-9]{2,5})?$'
    and origin !~ '\.[0-9]+(:[0-9]+)?$'
  ),
  label text not null check (char_length(label) between 1 and 120),
  business_type text not null default 'local' check (business_type in ('local', 'online')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, origin)
);

create table public.audit_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  status public.audit_run_status not null default 'queued',
  source public.audit_source not null default 'fixture',
  engine_version text check (engine_version is null or char_length(engine_version) <= 20),
  overall_score smallint check (overall_score between 0 and 100),
  overall_note text check (overall_note is null or char_length(overall_note) <= 500),
  category_scores jsonb not null default '{}'::jsonb check (jsonb_typeof(category_scores) = 'object'),
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  error text check (error is null or char_length(error) <= 500),
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint audit_run_state check (
    (status = 'queued' and started_at is null and finished_at is null)
    or (status = 'running' and started_at is not null and finished_at is null)
    or (status in ('completed', 'failed') and finished_at is not null)
  )
);
create index audit_runs_site_idx on public.audit_runs (site_id, queued_at desc);
create index audit_runs_ws_idx on public.audit_runs (workspace_id, queued_at desc);

create table public.audit_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.audit_runs (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  category public.finding_category not null,
  severity public.finding_severity not null,
  code text not null check (code ~ '^[a-z0-9_.]{2,60}$'),
  title text not null check (char_length(title) between 1 and 200),
  evidence text not null default '' check (char_length(evidence) <= 1000),
  recommendation text not null default '' check (char_length(recommendation) <= 1000),
  -- Recording that a fix was applied is the only thing that can change afterwards.
  fix_status public.fix_status not null default 'open',
  fix_note text check (fix_note is null or char_length(fix_note) <= 500),
  fixed_by uuid references auth.users (id) on delete set null,
  fixed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, code)
);
create index audit_findings_run_idx on public.audit_findings (run_id);
create index audit_findings_ws_idx on public.audit_findings (workspace_id);

alter table public.sites enable row level security;
alter table public.audit_runs enable row level security;
alter table public.audit_findings enable row level security;

-- ---------- Integrity triggers ----------------------------------------------------------

create or replace function private.trg_site_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.workspaces w where w.id = new.workspace_id and w.kind = 'client') then
      raise exception 'websites belong to client workspaces';
    end if;
    if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
  elsif new.workspace_id <> old.workspace_id or new.origin <> old.origin then
    raise exception 'a website''s workspace and address cannot be changed';
  end if;
  return new;
end;
$$;

-- Runs: created queued and as a sample run by anyone allowed to run audits; limited per day;
-- afterwards only ever moves forward, and only the server moves it.
create or replace function private.trg_run_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.sites s
      where s.id = new.site_id and s.workspace_id = new.workspace_id and s.archived_at is null
    ) then
      raise exception 'that website does not exist in this workspace';
    end if;
    if v_uid is not null then
      -- A person using the app: always a queued sample run, attributed to them.
      new.requested_by := v_uid;
      new.source := 'fixture';
      -- Parallel requests for the same workspace queue up here, so the counts below are exact.
      perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));
      if (select count(*) from public.audit_runs r
           where r.workspace_id = new.workspace_id and r.queued_at > now() - interval '24 hours') >= 20 then
        raise exception 'daily audit limit reached for this workspace (20 per 24 hours)';
      end if;
      if (select count(*) from public.audit_runs r
           where r.site_id = new.site_id and r.queued_at > now() - interval '24 hours') >= 5 then
        raise exception 'daily audit limit reached for this website (5 per 24 hours)';
      end if;
    end if;
    new.status := 'queued';
    new.engine_version := null; new.overall_score := null; new.overall_note := null;
    new.category_scores := '{}'::jsonb; new.counts := '{}'::jsonb; new.error := null;
    new.queued_at := now(); new.started_at := null; new.finished_at := null;
    return new;
  end if;

  -- UPDATE
  if new.workspace_id <> old.workspace_id or new.site_id <> old.site_id
     or new.requested_by is distinct from old.requested_by
     or new.source <> old.source or new.queued_at <> old.queued_at then
    raise exception 'an audit run''s owner, website and source cannot be changed';
  end if;
  if old.status in ('completed', 'failed') then raise exception 'this audit run is finished and cannot be changed'; end if;
  if not (
    (old.status = 'queued' and new.status in ('running', 'failed'))
    or (old.status = 'running' and new.status in ('completed', 'failed'))
    or new.status = old.status
  ) then
    raise exception 'an audit run cannot go from % to %', old.status, new.status;
  end if;
  if new.status = 'running' and old.status = 'queued' then new.started_at := now(); end if;
  if new.status in ('completed', 'failed') then new.finished_at := now(); end if;
  return new;
end;
$$;

-- Findings: added only while a run is in progress; never edited except for the fix record.
create or replace function private.trg_finding_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.audit_runs r
      where r.id = new.run_id and r.workspace_id = new.workspace_id and r.status = 'running'
    ) then
      raise exception 'findings can only be added to a running audit of the same workspace';
    end if;
    new.fix_status := 'open'; new.fix_note := null; new.fixed_by := null; new.fixed_at := null;
    new.created_at := now();
    return new;
  end if;

  if new.run_id <> old.run_id or new.workspace_id <> old.workspace_id or new.category <> old.category
     or new.severity <> old.severity or new.code <> old.code or new.title <> old.title
     or new.evidence <> old.evidence or new.recommendation <> old.recommendation
     or new.created_at <> old.created_at then
    raise exception 'audit findings cannot be edited - only the fix status can be recorded';
  end if;
  if new.fix_status is distinct from old.fix_status then
    if new.fix_status = 'open' then
      new.fixed_by := null; new.fixed_at := null;
    else
      if v_uid is null and (new.fixed_by is null or private.role_of_user(new.fixed_by, new.workspace_id) is distinct from 'admin') then
        raise exception 'a server-side fix record must name the Admin who made it (fixed_by)';
      end if;
      new.fixed_by := coalesce(v_uid, new.fixed_by);
      new.fixed_at := now();
    end if;
  elsif new.fixed_by is distinct from old.fixed_by or new.fixed_at is distinct from old.fixed_at then
    raise exception 'who fixed it and when are set by the system';
  end if;
  return new;
end;
$$;

create trigger sites_before before insert or update on public.sites
  for each row execute function private.trg_site_before();
create trigger audit_runs_before before insert or update on public.audit_runs
  for each row execute function private.trg_run_before();
create trigger audit_findings_before before insert or update on public.audit_findings
  for each row execute function private.trg_finding_before();

-- ---------- Audit trail -------------------------------------------------------------------

create or replace function private.trg_audit_seo()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row jsonb := to_jsonb(new);
  v_ws uuid := new.workspace_id;
  v_action text;
  v_meta jsonb;
  v_result public.audit_result := 'success';
begin
  if tg_table_name = 'sites' then
    v_action := case tg_op when 'INSERT' then 'site.added' else 'site.updated' end;
    v_meta := jsonb_build_object('origin', new.origin, 'label', new.label);
  elsif tg_table_name = 'audit_runs' then
    if tg_op = 'INSERT' then
      v_action := 'audit.requested';
    elsif new.status = old.status then
      return new;
    else
      v_action := 'audit.' || new.status::text;
      if new.status = 'failed' then v_result := 'failed'; end if;
    end if;
    v_meta := jsonb_build_object('site_id', new.site_id, 'source', new.source, 'requested_by', new.requested_by,
                                 'overall_score', new.overall_score);
  else -- audit_findings: only the fix record can change
    if new.fix_status is not distinct from old.fix_status and new.fix_note is not distinct from old.fix_note then return new; end if;
    v_action := case when new.fix_status is distinct from old.fix_status then 'finding.fix_' || new.fix_status::text else 'finding.fix_note_changed' end;
    v_meta := jsonb_build_object('code', new.code, 'run_id', new.run_id, 'from', old.fix_status, 'to', new.fix_status,
                                 'fixed_by', new.fixed_by, 'note_changed', new.fix_note is distinct from old.fix_note);
  end if;

  insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, metadata)
  values (
    v_uid,
    case when v_uid is null then 'system' else private.role_of_user(v_uid, v_ws)::text end,
    v_ws, 'seo_geo', v_action, tg_table_name, v_row ->> 'id', v_result, private.scrub_secrets(v_meta)
  );
  return new;
end;
$$;

create trigger sites_audit after insert or update on public.sites
  for each row execute function private.trg_audit_seo();
create trigger audit_runs_audit after insert or update on public.audit_runs
  for each row execute function private.trg_audit_seo();
create trigger audit_findings_audit after update on public.audit_findings
  for each row execute function private.trg_audit_seo();

-- ---------- Row Level Security ----------------------------------------------------------

-- Reading needs the "view" permission on the SEO/GEO module (every Client has it by default).
create policy sites_select on public.sites for select to authenticated
  using (private.holds(workspace_id, 'seo_geo', 'view'));
-- Adding or renaming a website is an "edit": Admins, and team members an Admin has allowed.
-- Clients never can (they may only run audits on websites their agency registered).
create policy sites_insert on public.sites for insert to authenticated
  with check (private.can_do(workspace_id, 'seo_geo', 'edit'));
create policy sites_update on public.sites for update to authenticated
  using (private.can_do(workspace_id, 'seo_geo', 'edit'))
  with check (private.can_do(workspace_id, 'seo_geo', 'edit'));

create policy runs_select on public.audit_runs for select to authenticated
  using (private.holds(workspace_id, 'seo_geo', 'view'));
-- "Run an audit" = create. Clients have it by default. It only queues a request.
create policy runs_insert on public.audit_runs for insert to authenticated
  with check (private.can_do(workspace_id, 'seo_geo', 'create'));

create policy findings_select on public.audit_findings for select to authenticated
  using (private.holds(workspace_id, 'seo_geo', 'view'));
-- Recording that a fix was applied is "apply a recommendation" = publish/execute. In practice
-- only an Admin can do it directly; anyone else's request goes through approval.
create policy findings_update on public.audit_findings for update to authenticated
  using (private.can_do(workspace_id, 'seo_geo', 'publish_execute'))
  with check (private.can_do(workspace_id, 'seo_geo', 'publish_execute'));

-- ---------- Privileges ------------------------------------------------------------------

revoke all on public.sites, public.audit_runs, public.audit_findings from anon, authenticated;
grant select on public.sites to authenticated;
grant insert (workspace_id, origin, label, business_type), update (label, business_type, archived_at)
  on public.sites to authenticated;
grant select on public.audit_runs to authenticated;
grant insert (workspace_id, site_id) on public.audit_runs to authenticated;
grant select on public.audit_findings to authenticated;
grant update (fix_status, fix_note) on public.audit_findings to authenticated;
-- No delete for anyone using the app. Results are written by the server (service role) only.
-- Not even the server key can delete or empty these tables: history (and the rate limit that
-- counts it) cannot be erased. Removing a website means archiving it.
revoke delete, truncate on public.sites, public.audit_runs, public.audit_findings from service_role;
