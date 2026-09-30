-- Phase G.16 follow-up - the website_url migration (20260930000600) granted insert and update
-- on workspaces.website_url but missed select, so any query returning that column (including
-- Supabase's own .insert().select() and .update().select() patterns - a normal INSERT/UPDATE
-- RETURNING under the hood) failed with "permission denied for table workspaces". Confirmed by
-- hand against the live database on 2026-09-30 (is_admin()/effective_role()/role_of_user() and
-- every other workspaces grant were all already correct - this was the one missing piece).

grant select (website_url) on public.workspaces to authenticated;
