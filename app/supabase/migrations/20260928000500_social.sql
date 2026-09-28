-- =====================================================================================
-- VMS Autopilot - Phase 3, migration 5: social publishing (SANDBOX ONLY)
--
-- Run AFTER migrations 0100-0400. Nothing here connects to Buffer or any social network.
--
-- The rules this file enforces (PRD 5.5, 8):
--   * A social channel (one Instagram account, one Facebook Page, ...) exists ONCE in the whole
--     platform. It can never be duplicated, not even under another workspace.
--   * A workspace can connect no more channels than its plan allows.
--   * Only the sandbox provider exists. A "buffer" connection is refused by a constraint until a
--     later, separately approved migration removes that constraint.
--   * A post must be approved before it can be scheduled or published, and approval freezes the
--     exact words (a fingerprint). Editing an approved post sends it back to Draft.
--   * A Client can never publish. Anyone else needs the Publish/Execute permission, and because
--     publishing is a sensitive action, in practice only an Admin can.
--   * A post can be published at most once: the publishing worker claims each attempt in a way
--     only one worker can win.
--   * Channels cannot be flooded, and every step is written to the audit log.
-- =====================================================================================

create type public.social_network as enum ('instagram', 'facebook', 'x', 'linkedin', 'google_business', 'youtube', 'tiktok');
create type public.social_post_status as enum ('draft', 'in_review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'cancelled');
create type public.social_channel_status as enum ('active', 'paused', 'disconnected', 'expired');
create type public.social_provider as enum ('sandbox', 'buffer');
create type public.social_plan_tier as enum ('free', 'paid');
create type public.social_publish_result as enum ('success', 'failed', 'rate_limited');

-- ---------- Tables ----------------------------------------------------------------------

-- Per-network limits. Filled by 20260928000600_social_limits_seed.sql (generated from TypeScript).
create table public.social_network_limits (
  network public.social_network primary key,
  max_chars integer not null check (max_chars > 0)
);

-- One row per workspace per provider: the plan the provider gave us and its channel limit.
create table public.social_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider public.social_provider not null default 'sandbox',
  plan_tier public.social_plan_tier not null default 'free',
  plan_name text not null check (char_length(plan_name) between 1 and 80),
  channel_limit smallint not null check (channel_limit between 0 and 100),
  refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, provider),
  -- PHASE 3 SAFETY LOCK: no real provider. A later migration, after the owner approves real
  -- integrations, replaces this constraint. Until then the database itself refuses Buffer.
  constraint social_sandbox_only check (provider = 'sandbox')
);

create table public.social_channels (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.social_connections (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  network public.social_network not null,
  external_id text not null check (external_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  display_name text not null check (char_length(display_name) between 1 and 120),
  handle text check (handle is null or char_length(handle) <= 120),
  status public.social_channel_status not null default 'active',
  created_at timestamptz not null default now(),
  -- The same social profile can exist only once in the whole platform (PRD 5.5).
  unique (network, external_id)
);
create index social_channels_ws_idx on public.social_channels (workspace_id);

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null references public.social_channels (id) on delete restrict,
  group_id uuid,
  body text not null check (char_length(body) between 1 and 63206),
  image_alt text check (image_alt is null or char_length(image_alt) <= 500),
  status public.social_post_status not null default 'draft',
  scheduled_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approved_hash text check (approved_hash is null or approved_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz,
  external_post_id text check (external_post_id is null or char_length(external_post_id) <= 200),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 3),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  constraint social_post_shape check (
    (status in ('approved', 'scheduled', 'publishing', 'published') and approved_hash is not null)
    or status not in ('approved', 'scheduled', 'publishing', 'published')
  ),
  constraint social_post_schedule check (status <> 'scheduled' or scheduled_at is not null)
);
create index social_posts_ws_idx on public.social_posts (workspace_id, status, scheduled_at);
create index social_posts_channel_idx on public.social_posts (channel_id, scheduled_at);
create index social_posts_due_idx on public.social_posts (scheduled_at) where status = 'scheduled';

-- One row each time the publishing worker takes a post. UNIQUE (post, attempt) is what makes the
-- claim safe: if two workers race, exactly one insert succeeds and the other stands down.
create table public.social_publish_attempts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  attempt_no smallint not null check (attempt_no between 1 and 3),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  result public.social_publish_result,
  error_code text check (error_code is null or char_length(error_code) <= 40),
  error_message text check (error_message is null or char_length(error_message) <= 300),
  unique (post_id, attempt_no)
);

alter table public.social_network_limits enable row level security;
alter table public.social_connections enable row level security;
alter table public.social_channels enable row level security;
alter table public.social_posts enable row level security;
alter table public.social_publish_attempts enable row level security;

-- ---------- Helpers ---------------------------------------------------------------------

-- The length a network actually counts against its limit. X (Twitter) always counts a link as
-- 23 characters, however long it really is; every other network counts what is actually typed.
-- Must match effectiveLength() in src/lib/social/networks.ts (a test compares them).
create or replace function private.social_effective_length(p_network public.social_network, p_body text)
returns integer language sql immutable set search_path = ''
as $$
  select case
    when p_network = 'x' then
      char_length(regexp_replace(p_body, 'https?://\S+', '', 'gi'))
      + 23 * (select count(*) from regexp_matches(p_body, 'https?://\S+', 'gi'))
    else char_length(p_body)
  end
$$;

-- Fingerprint of exactly what was approved: SHA-256 of  channel LF text LF picture-description.
-- Must match contentHash() in src/lib/social/hash.ts (a test compares them).
create or replace function private.social_hash(p_channel uuid, p_body text, p_alt text)
returns text language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(p_channel::text || chr(10) || p_body || chr(10) || coalesce(p_alt, ''), 'UTF8')), 'hex')
$$;

-- Which permission(s) let a person make this status change? NULL = not a legal move.
-- {server} = only the publishing worker. Must match TRANSITIONS in src/lib/social/state.ts.
create or replace function private.social_required_actions(p_from public.social_post_status, p_to public.social_post_status)
returns text[] language sql immutable set search_path = ''
as $$
  select case
    when p_from = 'draft' and p_to = 'in_review' then array['create', 'edit']
    when p_from = 'draft' and p_to = 'cancelled' then array['edit']
    when p_from = 'in_review' and p_to = 'draft' then array['approve', 'edit']
    when p_from = 'in_review' and p_to = 'approved' then array['approve']
    when p_from = 'in_review' and p_to = 'cancelled' then array['edit']
    when p_from = 'approved' and p_to = 'draft' then array['edit']
    when p_from = 'approved' and p_to = 'scheduled' then array['publish_execute']
    when p_from = 'approved' and p_to = 'publishing' then array['publish_execute']
    when p_from = 'approved' and p_to = 'cancelled' then array['edit']
    when p_from = 'scheduled' and p_to = 'approved' then array['publish_execute']
    when p_from = 'scheduled' and p_to = 'publishing' then array['server']
    when p_from = 'scheduled' and p_to = 'cancelled' then array['publish_execute']
    when p_from = 'publishing' and p_to = 'published' then array['server']
    when p_from = 'publishing' and p_to = 'failed' then array['server']
    when p_from = 'failed' and p_to = 'approved' then array['publish_execute']
    when p_from = 'failed' and p_to = 'draft' then array['edit']
    when p_from = 'failed' and p_to = 'cancelled' then array['edit']
  end
$$;

-- ---------- Connections and channels ------------------------------------------------------

create or replace function private.trg_social_connection_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.workspaces w where w.id = new.workspace_id and w.kind = 'client') then
      raise exception 'social connections belong to client workspaces';
    end if;
  elsif new.workspace_id <> old.workspace_id or new.provider <> old.provider then
    raise exception 'a connection''s workspace and provider cannot be changed';
  end if;
  return new;
end;
$$;

create or replace function private.trg_social_channel_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_conn public.social_connections;
  v_uid uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    select * into v_conn from public.social_connections c where c.id = new.connection_id;
    if not found or v_conn.workspace_id <> new.workspace_id then
      raise exception 'that connection does not belong to this workspace';
    end if;
    -- The plan's channel limit (a disconnected channel frees its slot).
    perform pg_advisory_xact_lock(hashtextextended(new.connection_id::text, 1));
    if (select count(*) from public.social_channels c where c.connection_id = new.connection_id and c.status <> 'disconnected') >= v_conn.channel_limit then
      raise exception 'this plan allows % channel(s) and all are in use', v_conn.channel_limit;
    end if;
    return new;
  end if;

  if new.connection_id <> old.connection_id or new.workspace_id <> old.workspace_id
     or new.network <> old.network or new.external_id <> old.external_id then
    raise exception 'a channel''s connection, network and account cannot be changed';
  end if;
  if new.status <> old.status and v_uid is not null then
    -- People using the app may only pause or resume a channel that is still connected.
    if not (old.status in ('active', 'paused') and new.status in ('active', 'paused')) then
      raise exception 'only the system can connect or disconnect a channel';
    end if;
    if not private.can_do(new.workspace_id, 'social', 'edit') then
      raise exception 'you do not have permission to pause or resume this channel';
    end if;
  end if;
  return new;
end;
$$;

-- ---------- Posts -----------------------------------------------------------------------

create or replace function private.trg_social_post_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_channel public.social_channels;
  v_max integer;
  v_required text[];
  v_action text;
  v_allowed boolean := false;
  v_content_changed boolean;
  v_status_changed boolean;
  v_day date;
begin
  select * into v_channel from public.social_channels c where c.id = new.channel_id;
  if not found or v_channel.workspace_id <> new.workspace_id then
    raise exception 'that channel does not exist in this workspace';
  end if;
  select l.max_chars into v_max from public.social_network_limits l where l.network = v_channel.network;

  if tg_op = 'INSERT' then
    if v_channel.status in ('disconnected', 'expired') then raise exception 'that channel is not connected'; end if;
    if btrim(new.body) = '' then raise exception 'the post is empty'; end if;
    if v_max is not null and private.social_effective_length(v_channel.network, new.body) > v_max then raise exception 'the post is longer than this network allows (% characters)', v_max; end if;
    if translate(new.body, chr(9) || chr(10) || chr(13), '') ~ '[[:cntrl:]]' then raise exception 'the post contains hidden control characters'; end if;
    if v_uid is not null then
      perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 2));
      if (select count(*) from public.social_posts p where p.workspace_id = new.workspace_id and p.created_at > now() - interval '24 hours') >= 200 then
        raise exception 'too many new posts today for this workspace (200 per 24 hours)';
      end if;
      new.created_by := v_uid;
    end if;
    new.status := 'draft'; new.scheduled_at := null;
    new.approved_by := null; new.approved_at := null; new.approved_hash := null;
    new.published_at := null; new.external_post_id := null; new.last_error := null;
    new.attempt_count := 0; new.mode := 'sandbox';
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;

  -- ---- UPDATE ----
  if new.workspace_id <> old.workspace_id or new.channel_id <> old.channel_id
     or new.created_by is distinct from old.created_by or new.created_at <> old.created_at
     or new.group_id is distinct from old.group_id or new.mode <> old.mode then
    raise exception 'a post''s workspace, channel, author and group cannot be changed';
  end if;

  v_content_changed := new.body <> old.body or new.image_alt is distinct from old.image_alt;
  v_status_changed := new.status <> old.status;

  if v_content_changed then
    if v_status_changed then raise exception 'change the words and the status in separate steps'; end if;
    if v_uid is not null and not private.can_do(new.workspace_id, 'social', 'edit') then
      raise exception 'you do not have permission to edit posts';
    end if;
    if old.status not in ('draft', 'in_review', 'approved', 'scheduled', 'failed') then
      raise exception 'a post that is % can no longer be edited', old.status;
    end if;
    if btrim(new.body) = '' then raise exception 'the post is empty'; end if;
    if v_max is not null and private.social_effective_length(v_channel.network, new.body) > v_max then raise exception 'the post is longer than this network allows (% characters)', v_max; end if;
    if translate(new.body, chr(9) || chr(10) || chr(13), '') ~ '[[:cntrl:]]' then raise exception 'the post contains hidden control characters'; end if;
    -- Editing anything already approved sends it back to Draft: it must be approved again.
    if old.status <> 'draft' then
      new.status := 'draft';
      new.approved_by := null; new.approved_at := null; new.approved_hash := null;
      new.scheduled_at := null; new.last_error := null;
    end if;
    new.updated_at := now();
    return new;
  end if;

  if not v_status_changed then
    if new.scheduled_at is distinct from old.scheduled_at and v_uid is not null then
      raise exception 'to change the time, unschedule the post first';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- ---- a status change ----
  v_required := private.social_required_actions(old.status, new.status);
  if v_required is null then raise exception 'a post that is % cannot become %', old.status, new.status; end if;
  if v_required = array['server'] then
    if v_uid is not null then raise exception 'only the publishing system can do this'; end if;
  elsif v_uid is not null then
    foreach v_action in array v_required loop
      if private.can_do(new.workspace_id, 'social', v_action::public.permission_action) then v_allowed := true; end if;
    end loop;
    if not v_allowed then raise exception 'you do not have permission to make that change (publishing needs an Admin)'; end if;
  end if;

  if new.status in ('in_review', 'approved', 'scheduled', 'publishing') and btrim(new.body) = '' then
    raise exception 'the post is empty';
  end if;

  if new.status = 'approved' and old.status = 'in_review' then
    if v_uid is null then raise exception 'a person must approve a post'; end if;
    if (old.created_by = v_uid or old.created_by is null) and not private.is_admin(new.workspace_id) then
      raise exception 'a second person needs to approve this post; you cannot approve one you wrote';
    end if;
    new.approved_by := v_uid; new.approved_at := now(); new.scheduled_at := null;
    new.approved_hash := private.social_hash(new.channel_id, new.body, new.image_alt);
  elsif new.status = 'approved' then
    -- back from scheduled, or a retry after failure: the approval must still be valid
    if old.approved_hash is distinct from private.social_hash(new.channel_id, new.body, new.image_alt) then
      raise exception 'the text changed after it was approved; it needs to be approved again';
    end if;
    new.scheduled_at := null;
  end if;

  if new.status = 'scheduled' then
    if new.scheduled_at is null then raise exception 'choose a date and time'; end if;
    if new.scheduled_at < now() + interval '5 minutes' then raise exception 'choose a time at least 5 minutes from now'; end if;
    if new.scheduled_at > now() + interval '90 days' then raise exception 'you can schedule up to 90 days ahead'; end if;
    if old.approved_hash is distinct from private.social_hash(new.channel_id, new.body, new.image_alt) then
      raise exception 'the text changed after it was approved; it needs to be approved again';
    end if;
    if v_channel.status <> 'active' then raise exception 'this channel is not active (%)', v_channel.status; end if;
    perform pg_advisory_xact_lock(hashtextextended(new.channel_id::text, 3));
    v_day := (new.scheduled_at at time zone 'UTC')::date;
    if (select count(*) from public.social_posts p
         where p.channel_id = new.channel_id and p.id <> new.id
           and p.status in ('scheduled', 'publishing', 'published')
           and (coalesce(p.published_at, p.scheduled_at, p.updated_at) at time zone 'UTC')::date = v_day) >= 10 then
      raise exception 'this channel already has 10 posts for that day; choose another day';
    end if;
  end if;

  if new.status = 'publishing' then
    if old.approved_hash is distinct from private.social_hash(new.channel_id, new.body, new.image_alt) then
      raise exception 'the text changed after it was approved; it needs to be approved again';
    end if;
    if v_channel.status <> 'active' then raise exception 'this channel is not active (%)', v_channel.status; end if;
    if old.attempt_count >= 3 then raise exception 'this post has been tried 3 times; write a new post'; end if;
    if old.status = 'scheduled' and old.scheduled_at > now() then raise exception 'this post is not due yet'; end if;
    new.attempt_count := old.attempt_count + 1;
    new.scheduled_at := null;
  end if;

  if new.status = 'published' then
    if new.external_post_id is null or btrim(new.external_post_id) = '' then raise exception 'a published post needs the provider''s post id'; end if;
    new.published_at := now(); new.last_error := null;
  elsif new.status = 'failed' then
    if new.last_error is null or btrim(new.last_error) = '' then raise exception 'a failed post needs a reason'; end if;
  elsif new.status in ('draft', 'cancelled') then
    new.scheduled_at := null;
    if new.status = 'draft' then new.approved_by := null; new.approved_at := null; new.approved_hash := null; end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.trg_social_attempt_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.social_posts;
begin
  if tg_op = 'INSERT' then
    select * into v_post from public.social_posts p where p.id = new.post_id;
    if not found or v_post.workspace_id <> new.workspace_id then raise exception 'that post does not exist in this workspace'; end if;
    if v_post.status <> 'publishing' then raise exception 'only a post that is being published can have an attempt'; end if;
    if new.attempt_no <> v_post.attempt_count then raise exception 'attempt number does not match the post'; end if;
    new.started_at := now(); new.finished_at := null; new.result := null; new.error_code := null; new.error_message := null;
    return new;
  end if;
  if old.finished_at is not null then raise exception 'a finished attempt cannot be changed'; end if;
  if new.post_id <> old.post_id or new.workspace_id <> old.workspace_id or new.attempt_no <> old.attempt_no
     or new.idempotency_key <> old.idempotency_key then
    raise exception 'an attempt''s post and number cannot be changed';
  end if;
  if new.result is not null then new.finished_at := now(); end if;
  return new;
end;
$$;

create trigger social_connections_before before insert or update on public.social_connections
  for each row execute function private.trg_social_connection_before();
create trigger social_channels_before before insert or update on public.social_channels
  for each row execute function private.trg_social_channel_before();
create trigger social_posts_before before insert or update on public.social_posts
  for each row execute function private.trg_social_post_before();
create trigger social_attempts_before before insert or update on public.social_publish_attempts
  for each row execute function private.trg_social_attempt_before();

-- ---------- Audit trail -------------------------------------------------------------------

create or replace function private.trg_audit_social()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid := new.workspace_id;
  v_action text;
  v_meta jsonb;
  v_result public.audit_result := 'success';
  v_target text := new.id::text;
begin
  if tg_table_name = 'social_connections' then
    v_action := case tg_op when 'INSERT' then 'social.connection_created' else 'social.connection_updated' end;
    v_meta := jsonb_build_object('provider', new.provider, 'plan', new.plan_name, 'channel_limit', new.channel_limit);
  elsif tg_table_name = 'social_channels' then
    if tg_op = 'UPDATE' and new.status = old.status then return new; end if;
    v_action := case when tg_op = 'INSERT' then 'social.channel_added' else 'social.channel_' || new.status::text end;
    v_meta := jsonb_build_object('network', new.network, 'display_name', new.display_name, 'status', new.status);
  else -- social_posts
    if tg_op = 'INSERT' then
      v_action := 'social.post_created';
    elsif new.body <> old.body or new.image_alt is distinct from old.image_alt then
      -- An edit is always logged as an edit, even when it also sent an approved post back to Draft.
      v_action := 'social.post_edited';
    elsif new.status <> old.status then
      v_action := case
        when old.status = 'draft' and new.status = 'in_review' then 'social.post_submitted'
        when old.status = 'scheduled' and new.status = 'approved' then 'social.post_unscheduled'
        when new.status = 'draft' then 'social.post_returned_to_draft'
        else 'social.post_' || new.status::text end;
      if new.status = 'failed' then v_result := 'failed'; end if;
    else
      return new;
    end if;
    -- The words themselves are not copied into the log; the fingerprint proves what was approved.
    v_meta := jsonb_build_object(
      'channel_id', new.channel_id, 'from', case when tg_op = 'UPDATE' then old.status end, 'to', new.status,
      'body_length', char_length(new.body), 'approved_hash', new.approved_hash,
      'scheduled_at', new.scheduled_at, 'attempt', new.attempt_count
    );
    if v_action = 'social.post_edited' then
      -- true when the edit undid an approval, so the post must be approved again
      v_meta := v_meta || jsonb_build_object('reapproval_needed', old.approved_hash is not null and new.approved_hash is null);
    end if;
  end if;

  insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, metadata)
  values (
    v_uid,
    case when v_uid is null then 'system' else private.role_of_user(v_uid, v_ws)::text end,
    v_ws, 'social', v_action, tg_table_name, v_target, v_result, private.scrub_secrets(v_meta)
  );
  return new;
end;
$$;

create trigger social_connections_audit after insert or update on public.social_connections
  for each row execute function private.trg_audit_social();
create trigger social_channels_audit after insert or update on public.social_channels
  for each row execute function private.trg_audit_social();
create trigger social_posts_audit after insert or update on public.social_posts
  for each row execute function private.trg_audit_social();

-- ---------- Row Level Security ----------------------------------------------------------

create policy limits_select on public.social_network_limits for select to authenticated using (true);

create policy social_conn_select on public.social_connections for select to authenticated
  using (private.holds(workspace_id, 'social', 'view'));
create policy social_channels_select on public.social_channels for select to authenticated
  using (private.holds(workspace_id, 'social', 'view'));
create policy social_channels_update on public.social_channels for update to authenticated
  using (private.can_do(workspace_id, 'social', 'edit')) with check (private.can_do(workspace_id, 'social', 'edit'));

create policy social_posts_select on public.social_posts for select to authenticated
  using (private.holds(workspace_id, 'social', 'view'));
create policy social_posts_insert on public.social_posts for insert to authenticated
  with check (private.can_do(workspace_id, 'social', 'create'));
-- Any member who can see a post may TRY an update; the trigger decides exactly what each
-- change needs (edit, approve, or publish/execute) and refuses the rest.
create policy social_posts_update on public.social_posts for update to authenticated
  using (private.holds(workspace_id, 'social', 'view')) with check (private.holds(workspace_id, 'social', 'view'));

create policy social_attempts_select on public.social_publish_attempts for select to authenticated
  using (private.is_admin(workspace_id));

-- ---------- Privileges ------------------------------------------------------------------

revoke all on public.social_network_limits, public.social_connections, public.social_channels,
  public.social_posts, public.social_publish_attempts from anon, authenticated;

grant select on public.social_network_limits to authenticated;
grant select on public.social_connections to authenticated;    -- written by the server only
grant select on public.social_channels to authenticated;
grant update (status) on public.social_channels to authenticated;   -- pause / resume
grant select on public.social_posts to authenticated;
grant insert (workspace_id, channel_id, group_id, body, image_alt) on public.social_posts to authenticated;
grant update (body, image_alt, status, scheduled_at) on public.social_posts to authenticated;
grant select on public.social_publish_attempts to authenticated;

-- Nobody, not even the server key, can delete social history, and the limits table is fixed.
revoke delete, truncate on public.social_connections, public.social_channels, public.social_posts,
  public.social_publish_attempts from service_role;
revoke insert, update, delete, truncate on public.social_network_limits from anon, authenticated, service_role;
