# Database (Supabase / Postgres)

**Nothing here has been applied to any Supabase project.** These are files to review first; when you
are ready, paste them into a **new, empty TEST project** — never a project with real client data.

## Paste order (Supabase → SQL Editor → New query)

1. `migrations/20260928000100_foundation_schema.sql` — tables and types
2. `migrations/20260928000200_security_functions_and_rls.sql` — the locks: who sees what, audit log, approvals
3. `migrations/20260928000300_permission_seed.sql` — the permission tables (generated; do not edit)
4. Sign up once in the app with the email you want as Admin, then edit the email in
   `manual/bootstrap_first_admin.sql` and run it. That makes you the first Admin.

Each file is complete on its own; run one, wait for "Success", then the next.

## What the database enforces by itself

Even if the app has a bug, Postgres refuses:

- A client seeing another client's (or another agency's) data.
- Anyone except an Admin granting, revoking or changing permissions — and anyone, Admin included, granting more than a role's ceiling (e.g. a client can never edit the website; a client can never have more than read-only AI).
- A non-admin executing a sensitive action directly — it must become an approval request that only an Admin can decide, and the requester can never approve their own.
- Editing or deleting the audit log — it is append-only, even for the server key.
- Reading stored integration credentials — that table is closed to every logged-in user; only the server key can touch it, and it stores a *reference* to a secret, never the secret.
- Removing the last Admin of an agency.
- Signing up giving any access at all.

## Safe to delete?

These files only *create* things. Nothing here drops or deletes existing data. The seed file replaces
only the three permission lookup tables.

## Real-Supabase notes to re-check when connecting (Phase 2)

- The tests run on an in-memory Postgres with a stand-in for Supabase's `auth` schema. Re-run the RLS
  checks against the real test project before trusting it.
- Keep the `private` schema out of *Exposed schemas* in Supabase → Settings → API.
- Keep email confirmation ON and public sign-ups restricted to invited people.
