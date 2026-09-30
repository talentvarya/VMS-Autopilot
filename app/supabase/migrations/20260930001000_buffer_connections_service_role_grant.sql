-- Phase G.11 fix - the original buffer_integration migration assumed service_role would get its
-- usual blanket default privileges on this new table (the same assumption ai_usage_log and
-- audit_log rely on), but a live connection attempt failed with "42501: permission denied for
-- table buffer_connections" - confirming the service-role client genuinely has no SQL-level
-- grant on this table (RLS is already bypassed by service_role; this is the separate, underlying
-- table-privilege check Postgres does first). Granting it directly, matching every other
-- service-role-only table's actual (not assumed) privileges.

grant select, insert, update, delete on public.buffer_connections to service_role;
