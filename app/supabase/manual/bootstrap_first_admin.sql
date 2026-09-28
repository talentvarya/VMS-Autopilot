-- =====================================================================================
-- VMS Autopilot - create the FIRST agency workspace and make one login its Admin.
--
-- When to run: once, in a TEST Supabase project, after the three migrations, and after
-- you have signed up (created a login) with the email you want to be Admin.
--
-- Why manual: signing up gives a person NO access. Nobody can make themselves an Admin
-- from the app. The very first Admin must be created here, by someone who owns the
-- Supabase project. After that, Admins add everyone else inside the app.
--
-- Before running: change the email on the line marked  <<< CHANGE THIS.
-- Safe to re-run: it refuses if that login is already an Admin.
-- =====================================================================================

do $$
declare
  v_email text := 'REPLACE-WITH-YOUR-EMAIL@example.com';  -- <<< CHANGE THIS
  v_agency_name text := 'My Agency';                       -- optional: your agency's name
  v_user uuid;
  v_workspace uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then
    raise exception 'No login found for "%". Sign up in the app with that email first, then run this again.', v_email;
  end if;

  if exists (select 1 from public.workspace_members where user_id = v_user and role = 'admin') then
    raise exception '"%" is already an Admin - nothing to do.', v_email;
  end if;

  insert into public.workspaces (kind, name) values ('agency', v_agency_name) returning id into v_workspace;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_workspace, v_user, 'admin');

  raise notice 'Done: "%" is now Admin of "%" (workspace id %).', v_email, v_agency_name, v_workspace;
end;
$$;
