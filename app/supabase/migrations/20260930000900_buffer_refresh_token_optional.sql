-- Phase G.11 fix - Buffer's real token response for this app does not include a refresh_token
-- field at all (confirmed live 2026-09-30: response was access_token/expires_in/scope/token_type
-- only, despite requesting the offline_access scope). The original migration required
-- refresh_token not null, which made every real connection attempt fail to save. Relaxing this
-- to nullable lets the read-only connection work with just an access token; when there is no
-- refresh token, the access token simply expires after its lifetime and the person reconnects
-- from the Connected Accounts page (the UI already shows "Connect" again once the stored
-- connection is gone/expired - no separate handling needed beyond that).

alter table public.buffer_connections alter column refresh_token drop not null;
