-- Phase G.19 - real Google Search Console connections, one per client workspace. Same shape and
-- safety model as buffer_connections (Phase G.11): tokens are service-role only, no grant to
-- `authenticated` at all, so no signed-in user's browser session can ever read a Google access or
-- refresh token directly. Read-only scope (webmasters.readonly) - this can never change a site's
-- Search Console settings, submit a sitemap, or request indexing.
--
-- refresh_token is nullable from day one (unlike buffer_connections' first version) - the Buffer
-- integration already taught this lesson live: a provider does not always hand back a refresh
-- token, and requiring one breaks every connection attempt that doesn't get one.
--
-- The grant to service_role is explicit from day one too, for the same reason: the earlier
-- buffer_connections migration assumed service_role's blanket default privileges would cover a
-- brand new table and that assumption was wrong in production (42501 permission denied), so this
-- migration does not repeat that assumption.

create table public.search_console_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  site_url text not null,
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz not null,
  connected_by uuid not null references auth.users (id) on delete restrict,
  connected_at timestamptz not null default now(),
  unique (workspace_id)
);
create index search_console_connections_workspace_idx on public.search_console_connections (workspace_id);

alter table public.search_console_connections enable row level security;
-- No policies for anon/authenticated - service-role only, same as buffer_connections.
grant select, insert, update, delete on public.search_console_connections to service_role;
