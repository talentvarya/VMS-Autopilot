-- Phase G.16 - real, live SEO/GEO audits (approved 2026-09-30, after being deliberately
-- switched off in Phase 2). Two small additions:
--   1. sites.source records which SnapshotSource (fixture vs live) queueAudit() should use for
--      that site - the 3 built-in sample sites stay 'fixture' (the default), a site created
--      from a real client's own website is 'live'.
--   2. workspaces.website_url lets a client have a real website on file, so the SEO/GEO Agent
--      has something to audit without anyone re-typing a URL every time.

alter table public.sites
  add column source text not null default 'fixture' check (source in ('fixture', 'live'));

grant insert (source) on public.sites to authenticated;

alter table public.workspaces
  add column website_url text check (website_url is null or char_length(website_url) <= 500);

grant insert (website_url), update (website_url) on public.workspaces to authenticated;
