# Database (Supabase / Postgres)

**Nothing here has been applied to any Supabase project.** These are files to review first; when you
are ready, paste them into a **new, empty TEST project** — never a project with real client data.

## Paste order (Supabase → SQL Editor → New query)

1. `migrations/20260928000100_foundation_schema.sql` — tables and types
2. `migrations/20260928000200_security_functions_and_rls.sql` — the locks: who sees what, audit log, approvals
3. `migrations/20260928000300_permission_seed.sql` — the permission tables (generated; do not edit)
4. `migrations/20260928000400_seo_audits.sql` — websites, audit runs and findings (Phase 2)
5. `migrations/20260928000500_social.sql` — channels, posts, publish attempts (Phase 3, sandbox only)
6. `migrations/20260928000600_social_limits_seed.sql` — per-network character limits (generated; do not edit)
7. Sign up once in the app with the email you want as Admin, then edit the email in
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
- A Client changing an audit result, faking a "live" audit, or applying a fix — Clients can only queue a sample audit, and audits are rate-limited (5 per website and 20 per workspace per day).
- Editing an audit finding after it is saved (only the "fix applied" record can change, and only an Admin can set it).
- Connecting a real ("buffer") social account — a table constraint refuses anything but `sandbox`, for every role including the server key.
- A social profile being connected twice — each one is unique across the whole platform, not just one workspace.
- A Client (or anyone) publishing directly, skipping approval, or publishing text that differs from what was approved — publishing is Admin-only, and the exact approved words are checked again immediately before anything is sent.
- A post being published twice — each attempt is claimed in a way only one worker can win.

## Safe to delete?

These files only *create* things. Nothing here drops or deletes existing data. The seed files
replace only their own lookup tables (permission rules, or per-network character limits).

## Real-Supabase notes to re-check when connecting (Phase 2, Phase 3)

- The tests run on an in-memory Postgres with a stand-in for Supabase's `auth` schema. Re-run the RLS
  checks against the real test project before trusting it.
- Keep the `private` schema out of *Exposed schemas* in Supabase → Settings → API.
- Keep email confirmation ON and public sign-ups restricted to invited people.
