-- =====================================================================================
-- VMS Autopilot - Runtime-Agent Phase, Sub-phase C: Content Agent (SANDBOX ONLY)
--
-- Run AFTER migration 20260929000200_social_super_agent.sql. Adds ONLY one new table and new
-- functions - nothing here changes any existing table, enum, policy or trigger from Phases
-- 1-4 or Sub-phases A/B. In particular sites/audit_runs/audit_findings (migration 0400) and
-- their triggers are completely untouched: the SEO/GEO Agent (Sub-phase C's other half) reads
-- and writes them through the EXISTING policies and the EXISTING executeAuditRun() function -
-- it needs no schema of its own at all.
--
-- What this file adds, in plain words:
--   * content_drafts - a long-form article/blog draft, with a life of the same shape as
--     Sub-phase B's social_reply_drafts: draft -> in_review -> approved/cancelled, with a
--     hash frozen at approval. There is deliberately NO "published" status: nothing in this
--     project can publish to a real website yet, so this table simply does not model that
--     step - exactly the same reasoning that kept "send"/"sent" out of social_reply_drafts.
--   * Reuses the EXISTING 'seo_geo' module and its EXISTING actions (view/create/edit/approve/
--     publish_execute) - no new permission module or action anywhere in this file. Per the
--     owner's explicit approval: a Client's existing 'seo_geo:create' default (already true
--     for running an audit) now also covers drafting an article. The GUARDRAILS that approval
--     came with are enforced structurally, not just by convention:
--       - the trigger allows ONLY 'draft' as the status an insert can ever produce - an agent
--         (or a person) can never insert anything already approved;
--       - moving to 'approved' still requires the 'approve' action, exactly like a post or a
--         reply, and a person can never approve a draft they themselves wrote (an Admin is the
--         only exception, same rule as everywhere else) - there is no tool in this project
--         that lets an agent call this transition on its own behalf;
--       - there is no "published" status and no code path that reaches a live website, so
--         "publishing remains Admin-approved" is true by construction: nothing here can
--         publish at all yet.
-- =====================================================================================

create type public.content_draft_status as enum ('draft', 'in_review', 'approved', 'cancelled');

create table public.content_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 50000),
  status public.content_draft_status not null default 'draft',
  -- The audit_findings row that inspired this article, when the SEO/GEO Agent handed off a
  -- content brief. NULL for an article written without one.
  source_finding_id uuid references public.audit_findings (id) on delete set null,
  drafted_by_agent boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approved_hash text check (approved_hash is null or approved_hash ~ '^[0-9a-f]{64}$'),
  constraint content_draft_shape check (
    (status = 'approved' and approved_hash is not null) or (status <> 'approved')
  )
);
create index content_drafts_ws_idx on public.content_drafts (workspace_id, status);
create index content_drafts_finding_idx on public.content_drafts (source_finding_id);

alter table public.content_drafts enable row level security;

-- ---------- Helpers -----------------------------------------------------------------------

-- Mirrors the SHAPE of private.social_reply_required_actions() - same four-state life.
create or replace function private.content_draft_required_actions(p_from public.content_draft_status, p_to public.content_draft_status)
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

-- Fingerprint of exactly what was approved. Must match contentDraftHash() in
-- app/src/lib/agents/content/state.ts (a test compares them).
create or replace function private.content_draft_hash(p_title text, p_body text)
returns text language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(p_title || chr(10) || p_body, 'UTF8')), 'hex')
$$;

-- ---------- Content drafts ------------------------------------------------------------------

create or replace function private.trg_content_draft_before()
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
  if new.source_finding_id is not null and not exists (
    select 1 from public.audit_findings f where f.id = new.source_finding_id and f.workspace_id = new.workspace_id
  ) then
    raise exception 'that finding does not exist in this workspace';
  end if;

  if tg_op = 'INSERT' then
    if btrim(new.title) = '' or btrim(new.body) = '' then raise exception 'the article needs a title and body'; end if;
    if v_uid is not null then new.created_by := v_uid; end if;
    -- However it arrives, an insert is always a plain draft - never pre-approved.
    new.status := 'draft';
    new.approved_by := null; new.approved_at := null; new.approved_hash := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;

  if new.workspace_id <> old.workspace_id or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at or new.drafted_by_agent <> old.drafted_by_agent
     or new.source_finding_id is distinct from old.source_finding_id then
    raise exception 'a content draft''s workspace, author, origin and source finding cannot be changed';
  end if;

  v_content_changed := new.title <> old.title or new.body <> old.body;
  v_status_changed := new.status <> old.status;

  if v_content_changed then
    if v_status_changed then raise exception 'change the words and the status in separate steps'; end if;
    if v_uid is not null and not private.can_do(new.workspace_id, 'seo_geo', 'edit') then
      raise exception 'you do not have permission to edit content drafts';
    end if;
    if old.status not in ('draft', 'in_review', 'approved') then
      raise exception 'a draft that is % can no longer be edited', old.status;
    end if;
    if btrim(new.title) = '' or btrim(new.body) = '' then raise exception 'the article needs a title and body'; end if;
    -- Editing anything already approved sends it back to Draft: it must be approved again.
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

  v_required := private.content_draft_required_actions(old.status, new.status);
  if v_required is null then raise exception 'a draft that is % cannot become %', old.status, new.status; end if;
  if v_uid is not null then
    foreach v_action in array v_required loop
      if private.can_do(new.workspace_id, 'seo_geo', v_action::public.permission_action) then v_allowed := true; end if;
    end loop;
    if not v_allowed then raise exception 'you do not have permission to make that change'; end if;
  end if;

  if new.status = 'approved' and old.status = 'in_review' then
    if v_uid is null then raise exception 'a person must approve an article'; end if;
    if (old.created_by = v_uid or old.created_by is null) and not private.is_admin(new.workspace_id) then
      raise exception 'a second person needs to approve this article; you cannot approve one you wrote';
    end if;
    new.approved_by := v_uid; new.approved_at := now();
    new.approved_hash := private.content_draft_hash(new.title, new.body);
  elsif new.status = 'draft' then
    new.approved_by := null; new.approved_at := null; new.approved_hash := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger content_drafts_before before insert or update on public.content_drafts
  for each row execute function private.trg_content_draft_before();

-- ---------- Audit trail ---------------------------------------------------------------------

create or replace function private.trg_audit_content_drafts()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_action text;
  v_meta jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'content.draft_created';
  elsif new.title <> old.title or new.body <> old.body then
    v_action := 'content.draft_edited';
  else
    v_action := 'content.draft_' || new.status::text;
  end if;
  v_meta := jsonb_build_object('status', new.status, 'drafted_by_agent', new.drafted_by_agent, 'source_finding_id', new.source_finding_id, 'approved_hash', new.approved_hash);

  insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, metadata)
  values (v_uid, case when v_uid is null then 'system' else private.role_of_user(v_uid, new.workspace_id)::text end, new.workspace_id, 'seo_geo', v_action, 'content_drafts', new.id::text, 'success', private.scrub_secrets(v_meta));
  return new;
end;
$$;

create trigger content_drafts_audit after insert or update on public.content_drafts
  for each row execute function private.trg_audit_content_drafts();

-- ---------- Row Level Security ----------------------------------------------------------

create policy content_drafts_select on public.content_drafts for select to authenticated
  using (private.holds(workspace_id, 'seo_geo', 'view'));
create policy content_drafts_insert on public.content_drafts for insert to authenticated
  with check (private.can_do(workspace_id, 'seo_geo', 'create'));
-- Any member who can see a draft may TRY an update; the trigger decides exactly what each
-- change needs (edit or approve) and refuses the rest - same pattern as social_posts.
create policy content_drafts_update on public.content_drafts for update to authenticated
  using (private.holds(workspace_id, 'seo_geo', 'view')) with check (private.holds(workspace_id, 'seo_geo', 'view'));

-- ---------- Privileges ------------------------------------------------------------------

revoke all on public.content_drafts from anon, authenticated;
grant select on public.content_drafts to authenticated;
grant insert (workspace_id, title, body, source_finding_id, drafted_by_agent) on public.content_drafts to authenticated;
grant update (title, body, status) on public.content_drafts to authenticated;
