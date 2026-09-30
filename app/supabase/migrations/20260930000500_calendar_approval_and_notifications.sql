-- Phase G.14 - approval + reminders for the real Content Calendar (Phase G.10). Every
-- generated calendar slot now starts 'pending' and needs an Admin's explicit approval before
-- the day it's planned for - the reminder job (a Vercel Cron hitting
-- /api/cron/calendar-approval-reminders) nudges whoever needs to approve it, it never approves
-- anything itself.

alter table public.social_content_calendar_items
  add column approval_status text not null default 'pending' check (approval_status in ('pending', 'approved'));

grant update (approval_status) on public.social_content_calendar_items to authenticated;
-- Reuses the existing social_calendar_update RLS policy (can_do(workspace_id, 'social', 'edit')) -
-- no new policy needed, this is just one more grantable column under the same rule.

-- ---------- Notifications ---------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 60),
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 500),
  related_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications (recipient_user_id, created_at desc);

alter table public.notifications enable row level security;

create policy notifications_select on public.notifications for select to authenticated
  using (recipient_user_id = (select auth.uid()));
create policy notifications_update on public.notifications for update to authenticated
  using (recipient_user_id = (select auth.uid()))
  with check (recipient_user_id = (select auth.uid()));

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
-- No insert grant for `authenticated` on purpose: only the cron job (service-role) ever creates
-- a notification, so no signed-in session can write its own or anyone else's notifications feed.
