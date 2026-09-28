-- =====================================================================================
-- VMS Autopilot - Runtime-Agent Phase, Sub-phase B: Social Media Super Agent (SANDBOX ONLY)
--
-- Run AFTER migration 20260929000100_agents_foundation.sql. Adds ONLY new tables and new
-- functions - nothing here changes any existing table, enum, policy or trigger from Phases
-- 1-4 or from Sub-phase A. In particular, social_posts and its own trigger
-- (private.trg_social_post_before) are completely untouched: a draft this agent creates is
-- written through the app's normal insert path and is governed by that EXISTING trigger,
-- exactly as a human's own draft already is.
--
-- What this file adds, in plain words:
--   * social_interactions - an incoming comment or DM, stored as DATA. Nothing here ever
--     treats its text as an instruction; the only thing that can be done with one is draft a
--     reply to it (see social_reply_drafts). Written only by the server (no real webhook
--     exists in sandbox mode).
--   * social_reply_drafts - a reply to one interaction, with its own small life of the same
--     shape as a post's: drafted -> in_review -> approved, with a hash-freeze on approval
--     exactly like a post's approved_hash, and a return to "drafted" if it is edited or sent
--     back for changes. There is deliberately NO "sending" or "sent" status yet: this phase
--     does not send anything, and building a send-path now would be speculative.
--   * social_content_calendar_items - a planned calendar slot, linking to the real posts it
--     produced once drafted.
--   * brand_voice_profiles - one row per workspace: tone, prohibited words, example posts.
--     Deliberately NOT governed by a blanket reuse of 'social:edit' - see the RLS policies
--     below. Admin can always set it; a Team member only with an explicit grant; a Client can
--     never set it, even if granted 'social:edit' for ordinary post editing.
--   * Every new table reuses the EXISTING 'social' module and its four EXISTING actions
--     (view, create, approve, publish_execute) - no new permission module or action is added
--     anywhere in this file.
-- =====================================================================================

create type public.social_interaction_kind as enum ('comment', 'dm');
create type public.social_interaction_status as enum ('new', 'drafted', 'ignored');
create type public.social_reply_status as enum ('drafted', 'in_review', 'approved', 'cancelled');
create type public.social_calendar_status as enum ('planned', 'drafted', 'skipped');

-- ---------- Tables ----------------------------------------------------------------------

create table public.social_interactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null references public.social_channels (id) on delete cascade,
  kind public.social_interaction_kind not null,
  external_interaction_id text not null check (char_length(external_interaction_id) between 1 and 200),
  author_handle text check (author_handle is null or char_length(author_handle) <= 200),
  -- The untrusted text itself. Read only to draft a reply to it - never as instructions.
  body_raw text not null check (char_length(body_raw) <= 10000),
  received_at timestamptz not null default now(),
  status public.social_interaction_status not null default 'new',
  intent_flag text check (intent_flag is null or intent_flag ~ '^[a-z0-9_]{2,60}$'),
  created_at timestamptz not null default now(),
  unique (channel_id, external_interaction_id)
);
create index social_interactions_ws_idx on public.social_interactions (workspace_id, received_at desc);

create table public.social_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  interaction_id uuid not null references public.social_interactions (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  status public.social_reply_status not null default 'drafted',
  drafted_by_agent boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approved_hash text check (approved_hash is null or approved_hash ~ '^[0-9a-f]{64}$'),
  constraint social_reply_shape check (
    (status = 'approved' and approved_hash is not null) or (status <> 'approved')
  )
);
create index social_reply_drafts_ws_idx on public.social_reply_drafts (workspace_id, status);
create index social_reply_drafts_interaction_idx on public.social_reply_drafts (interaction_id);

create table public.social_content_calendar_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  planned_date date not null,
  theme text not null check (char_length(theme) between 1 and 200),
  target_networks jsonb not null default '[]'::jsonb check (jsonb_typeof(target_networks) = 'array'),
  status public.social_calendar_status not null default 'planned',
  linked_post_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(linked_post_ids) = 'array'),
  generated_by_agent boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index social_calendar_ws_idx on public.social_content_calendar_items (workspace_id, planned_date);

create table public.brand_voice_profiles (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  tone text check (tone is null or char_length(tone) <= 500),
  prohibited_words jsonb not null default '[]'::jsonb check (jsonb_typeof(prohibited_words) = 'array'),
  example_posts jsonb not null default '[]'::jsonb check (jsonb_typeof(example_posts) = 'array'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.social_interactions enable row level security;
alter table public.social_reply_drafts enable row level security;
alter table public.social_content_calendar_items enable row level security;
alter table public.brand_voice_profiles enable row level security;

-- ---------- Helpers -----------------------------------------------------------------------

-- Which permission(s) let a person make this reply status change? Mirrors the SHAPE of
-- private.social_required_actions() (migration 0500) but for the shorter reply life - no
-- scheduling or publishing exists for a reply yet.
create or replace function private.social_reply_required_actions(p_from public.social_reply_status, p_to public.social_reply_status)
returns text[] language sql immutable set search_path = ''
as $$
  select case
    when p_from = 'drafted' and p_to = 'in_review' then array['create', 'edit']
    when p_from = 'drafted' and p_to = 'cancelled' then array['edit']
    when p_from = 'in_review' and p_to = 'drafted' then array['approve', 'edit']
    when p_from = 'in_review' and p_to = 'approved' then array['approve']
    when p_from = 'in_review' and p_to = 'cancelled' then array['edit']
    when p_from = 'approved' and p_to = 'drafted' then array['edit']
    when p_from = 'approved' and p_to = 'cancelled' then array['edit']
  end
$$;

-- Fingerprint of exactly what was approved: SHA-256 of  interaction id LF reply text.
-- Must match replyContentHash() in app/src/lib/agents/social/state.ts (a test compares them).
create or replace function private.social_reply_hash(p_interaction uuid, p_body text)
returns text language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(p_interaction::text || chr(10) || p_body, 'UTF8')), 'hex')
$$;

-- ---------- Interactions ------------------------------------------------------------------

create or replace function private.trg_social_interaction_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_channel public.social_channels;
begin
  select * into v_channel from public.social_channels c where c.id = new.channel_id;
  if not found or v_channel.workspace_id <> new.workspace_id then
    raise exception 'that channel does not exist in this workspace';
  end if;
  new.created_at := now();
  return new;
end;
$$;

-- ---------- Reply drafts ------------------------------------------------------------------

create or replace function private.trg_social_reply_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_interaction public.social_interactions;
  v_required text[];
  v_action text;
  v_allowed boolean := false;
  v_content_changed boolean;
  v_status_changed boolean;
begin
  select * into v_interaction from public.social_interactions i where i.id = new.interaction_id;
  if not found or v_interaction.workspace_id <> new.workspace_id then
    raise exception 'that interaction does not exist in this workspace';
  end if;

  if tg_op = 'INSERT' then
    if btrim(new.body) = '' then raise exception 'the reply is empty'; end if;
    if v_uid is not null then new.created_by := v_uid; end if;
    new.status := 'drafted';
    new.approved_by := null; new.approved_at := null; new.approved_hash := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;

  if new.workspace_id <> old.workspace_id or new.interaction_id <> old.interaction_id
     or new.created_by is distinct from old.created_by or new.created_at <> old.created_at
     or new.drafted_by_agent <> old.drafted_by_agent then
    raise exception 'a reply draft''s workspace, interaction, author and origin cannot be changed';
  end if;

  v_content_changed := new.body <> old.body;
  v_status_changed := new.status <> old.status;

  if v_content_changed then
    if v_status_changed then raise exception 'change the words and the status in separate steps'; end if;
    if v_uid is not null and not private.can_do(new.workspace_id, 'social', 'edit') then
      raise exception 'you do not have permission to edit reply drafts';
    end if;
    if old.status not in ('drafted', 'in_review', 'approved') then
      raise exception 'a reply that is % can no longer be edited', old.status;
    end if;
    if btrim(new.body) = '' then raise exception 'the reply is empty'; end if;
    -- Editing anything already approved sends it back to Drafted: it must be approved again.
    if old.status <> 'drafted' then
      new.status := 'drafted';
      new.approved_by := null; new.approved_at := null; new.approved_hash := null;
    end if;
    new.updated_at := now();
    return new;
  end if;

  if not v_status_changed then
    new.updated_at := now();
    return new;
  end if;

  v_required := private.social_reply_required_actions(old.status, new.status);
  if v_required is null then raise exception 'a reply that is % cannot become %', old.status, new.status; end if;
  if v_uid is not null then
    foreach v_action in array v_required loop
      if private.can_do(new.workspace_id, 'social', v_action::public.permission_action) then v_allowed := true; end if;
    end loop;
    if not v_allowed then raise exception 'you do not have permission to make that change'; end if;
  end if;

  if new.status = 'approved' and old.status = 'in_review' then
    if v_uid is null then raise exception 'a person must approve a reply'; end if;
    if (old.created_by = v_uid or old.created_by is null) and not private.is_admin(new.workspace_id) then
      raise exception 'a second person needs to approve this reply; you cannot approve one you wrote';
    end if;
    new.approved_by := v_uid; new.approved_at := now();
    new.approved_hash := private.social_reply_hash(new.interaction_id, new.body);
  elsif new.status = 'drafted' then
    new.approved_by := null; new.approved_at := null; new.approved_hash := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- ---------- Calendar ---------------------------------------------------------------------

create or replace function private.trg_social_calendar_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
    new.created_at := now();
  else
    if new.workspace_id <> old.workspace_id or new.created_by is distinct from old.created_by
       or new.created_at <> old.created_at then
      raise exception 'a calendar item''s workspace and author cannot be changed';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- Brand voice -------------------------------------------------------------------

create or replace function private.trg_brand_voice_before()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := now();
  if (select auth.uid()) is not null then new.updated_by := (select auth.uid()); end if;
  return new;
end;
$$;

create trigger social_interactions_before before insert on public.social_interactions
  for each row execute function private.trg_social_interaction_before();
create trigger social_reply_drafts_before before insert or update on public.social_reply_drafts
  for each row execute function private.trg_social_reply_before();
create trigger social_calendar_before before insert or update on public.social_content_calendar_items
  for each row execute function private.trg_social_calendar_before();
create trigger brand_voice_before before insert or update on public.brand_voice_profiles
  for each row execute function private.trg_brand_voice_before();

-- ---------- Audit trail ---------------------------------------------------------------------

create or replace function private.trg_audit_social_super_agent()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_action text;
  v_meta jsonb;
  v_target text;
begin
  if tg_table_name = 'social_interactions' then
    v_ws := new.workspace_id; v_target := new.id::text;
    v_action := 'social.interaction_received';
    v_meta := jsonb_build_object('channel_id', new.channel_id, 'kind', new.kind);
  elsif tg_table_name = 'social_reply_drafts' then
    v_ws := new.workspace_id; v_target := new.id::text;
    if tg_op = 'INSERT' then
      v_action := 'social.reply_drafted';
    elsif new.body <> old.body then
      v_action := 'social.reply_edited';
    else
      v_action := 'social.reply_' || new.status::text;
    end if;
    v_meta := jsonb_build_object('interaction_id', new.interaction_id, 'status', new.status, 'drafted_by_agent', new.drafted_by_agent, 'approved_hash', new.approved_hash);
  elsif tg_table_name = 'social_content_calendar_items' then
    v_ws := new.workspace_id; v_target := new.id::text;
    v_action := case tg_op when 'INSERT' then 'social.calendar_item_created' else 'social.calendar_item_updated' end;
    v_meta := jsonb_build_object('planned_date', new.planned_date, 'status', new.status, 'generated_by_agent', new.generated_by_agent);
  else -- brand_voice_profiles
    v_ws := new.workspace_id; v_target := new.workspace_id::text;
    v_action := case tg_op when 'INSERT' then 'social.brand_voice_created' else 'social.brand_voice_updated' end;
    v_meta := jsonb_build_object('has_tone', new.tone is not null, 'prohibited_word_count', jsonb_array_length(new.prohibited_words));
  end if;

  insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, metadata)
  values (v_uid, case when v_uid is null then 'system' else private.role_of_user(v_uid, v_ws)::text end, v_ws, 'social', v_action, tg_table_name, v_target, 'success', private.scrub_secrets(v_meta));
  return new;
end;
$$;

create trigger social_interactions_audit after insert on public.social_interactions
  for each row execute function private.trg_audit_social_super_agent();
create trigger social_reply_drafts_audit after insert or update on public.social_reply_drafts
  for each row execute function private.trg_audit_social_super_agent();
create trigger social_calendar_audit after insert or update on public.social_content_calendar_items
  for each row execute function private.trg_audit_social_super_agent();
create trigger brand_voice_audit after insert or update on public.brand_voice_profiles
  for each row execute function private.trg_audit_social_super_agent();

-- ---------- Row Level Security ----------------------------------------------------------

-- Interactions: readable by anyone who can already see social content here. Written only by
-- the server (service_role) - there is no real webhook to receive one from in sandbox mode.
create policy social_interactions_select on public.social_interactions for select to authenticated
  using (private.holds(workspace_id, 'social', 'view'));

create policy social_reply_drafts_select on public.social_reply_drafts for select to authenticated
  using (private.holds(workspace_id, 'social', 'view'));
create policy social_reply_drafts_insert on public.social_reply_drafts for insert to authenticated
  with check (private.can_do(workspace_id, 'social', 'create'));
-- Any member who can see a reply may TRY an update; the trigger decides exactly what each
-- change needs (edit or approve) and refuses the rest - same pattern as social_posts.
create policy social_reply_drafts_update on public.social_reply_drafts for update to authenticated
  using (private.holds(workspace_id, 'social', 'view')) with check (private.holds(workspace_id, 'social', 'view'));

create policy social_calendar_select on public.social_content_calendar_items for select to authenticated
  using (private.holds(workspace_id, 'social', 'view'));
create policy social_calendar_insert on public.social_content_calendar_items for insert to authenticated
  with check (private.can_do(workspace_id, 'social', 'create'));
create policy social_calendar_update on public.social_content_calendar_items for update to authenticated
  using (private.can_do(workspace_id, 'social', 'edit')) with check (private.can_do(workspace_id, 'social', 'edit'));

-- Brand voice: readable by anyone who can see social content. Writable by an Admin always;
-- by a Team member only with an explicit grant; a Client can NEVER write this, even if
-- granted 'social:edit' for ordinary post editing - that grant governs individual posts, not
-- the workspace-wide brand-voice baseline. This is deliberately more specific than a blanket
-- reuse of an existing action (approved design decision for Sub-phase B).
create policy brand_voice_select on public.brand_voice_profiles for select to authenticated
  using (private.holds(workspace_id, 'social', 'view'));
create policy brand_voice_insert on public.brand_voice_profiles for insert to authenticated
  with check (
    private.is_admin(workspace_id)
    or (private.effective_role(workspace_id) = 'team_member' and private.can_do(workspace_id, 'social', 'edit'))
  );
create policy brand_voice_update on public.brand_voice_profiles for update to authenticated
  using (
    private.is_admin(workspace_id)
    or (private.effective_role(workspace_id) = 'team_member' and private.can_do(workspace_id, 'social', 'edit'))
  )
  with check (
    private.is_admin(workspace_id)
    or (private.effective_role(workspace_id) = 'team_member' and private.can_do(workspace_id, 'social', 'edit'))
  );

-- ---------- Privileges ------------------------------------------------------------------

revoke all on public.social_interactions, public.social_reply_drafts, public.social_content_calendar_items, public.brand_voice_profiles
  from anon, authenticated;

grant select on public.social_interactions to authenticated; -- written by the server only

grant select on public.social_reply_drafts to authenticated;
grant insert (workspace_id, interaction_id, body, drafted_by_agent) on public.social_reply_drafts to authenticated;
grant update (body, status) on public.social_reply_drafts to authenticated;

grant select on public.social_content_calendar_items to authenticated;
grant insert (workspace_id, planned_date, theme, target_networks, generated_by_agent) on public.social_content_calendar_items to authenticated;
grant update (theme, target_networks, status, linked_post_ids) on public.social_content_calendar_items to authenticated;

grant select on public.brand_voice_profiles to authenticated;
grant insert (workspace_id, tone, prohibited_words, example_posts) on public.brand_voice_profiles to authenticated;
grant update (tone, prohibited_words, example_posts) on public.brand_voice_profiles to authenticated;
