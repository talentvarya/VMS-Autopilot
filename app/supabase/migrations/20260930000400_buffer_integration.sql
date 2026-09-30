-- Phase G.11 - real Buffer OAuth connections, one per client workspace. Separate from the
-- existing sandbox social_channels/social_posts tables on purpose: this only stores a link
-- between a client workspace and a real Buffer account (tokens + read-only insights), and never
-- touches the sandbox's own publish-simulation model. No draft/publish flow reads from or
-- writes to this table - insights are read-only, and a real "post from here" feature is a
-- separate, future decision.
--
-- Tokens are service-role only, exactly like ai_usage_log and audit_log: no grant to
-- `authenticated` at all, so no signed-in user's own browser session can ever read a Buffer
-- access/refresh token directly, no matter their role. Every route that needs the token reads
-- it server-side with the service-role client (src/lib/supabase/service.ts).

create table public.buffer_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  buffer_organization_id text not null,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  connected_by uuid not null references auth.users (id) on delete restrict,
  connected_at timestamptz not null default now(),
  unique (workspace_id)
);
create index buffer_connections_workspace_idx on public.buffer_connections (workspace_id);

alter table public.buffer_connections enable row level security;
-- No policies, no grants to `authenticated` - service-role only (bypasses RLS entirely),
-- matching ai_usage_log / audit_log's existing pattern.
