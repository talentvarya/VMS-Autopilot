# VMS Autopilot — app (Phase 1: foundation, Phase 2: SEO / GEO audits, Phase 3: social publishing)

The Next.js application. It shows the **approved dashboard exactly as designed**
(`../interface/` is the untouched reference) and contains the **permission model**, the
**database design** and the **tests** that later phases build on.

**Phase 4** organized and validated the `../agency-agents/` persona catalog against a fixed
9-agent future runtime architecture — no code in this `app/` folder changed. See
[`../docs/AGENT-RUNTIME-ARCHITECTURE.md`](../docs/AGENT-RUNTIME-ARCHITECTURE.md) (the 9 agents),
[`../docs/AGENT-CATALOG-MAPPING.md`](../docs/AGENT-CATALOG-MAPPING.md) (catalog-to-agent mapping)
and [`../docs/AGENT-CATALOG-VALIDATION.md`](../docs/AGENT-CATALOG-VALIDATION.md) (the five
read-only catalog validation checks and their results).

## What is and is not connected

| | Status after Phase 3 |
|---|---|
| Dashboard screen | Looks identical to the approved design. Numbers are still sample data. |
| SEO / GEO Audit page | **Works on invented sample websites only.** No real website is ever contacted; live audits are switched off in code and covered by a test. |
| Social Publishing page | **Works entirely against a sandbox.** No real Buffer or social account is ever contacted; connecting one is switched off in code and covered by a test. Publishing only pretends. |
| Login / Supabase | **Not connected.** No keys, no accounts, no network calls. |
| Database | SQL files are written and tested, but **not applied anywhere yet**. |
| Google/Meta Ads, domains | **Not started** (Phases 4–6). |

Nothing in this folder can post, spend money or touch a real client.

## Folder map

| Path | What it is |
|---|---|
| `src/app/` | The page shell and `globals.css` (approved CSS first, then small-screen + accessibility additions) |
| `src/components/Dashboard.tsx` | The dashboard, ported from `../interface/src/App.tsx` |
| `src/lib/permissions/` | **The rules**: roles, what each may do, what needs approval, AI read-only rule, audit helpers |
| `src/lib/seo/` | The audit engine (reads a page, returns findings and scores), sample websites, the address-safety guard, CSV export, the server-side runner |
| `src/components/SeoAuditModule.tsx` | The SEO / GEO Audit page |
| `src/lib/social/` | The publishing rules (state machine, per-network limits, approval-freezing fingerprint), the sandbox provider (a pretend Buffer), the server-side worker, sample channels and posts |
| `src/components/SocialModule.tsx` (+ `src/components/social/`) | The Social Publishing page: channels, calendar, composer, post list |
| `supabase/migrations/` | The database, in paste order: `…0100_foundation_schema.sql`, `…0200_security_functions_and_rls.sql`, `…0300_permission_seed.sql`, `…0400_seo_audits.sql`, `…0500_social.sql`, `…0600_social_limits_seed.sql` |
| `supabase/manual/` | One-off scripts (create the first Admin). See `supabase/README.md` |
| `tests/` | Automated tests (permissions, real-Postgres security tests, dashboard fidelity + accessibility) |

## Commands

Run these from this `app/` folder.

| Command | What it does |
|---|---|
| `npm install` | Install everything (first time only) |
| `npm run dev` | Start the app locally at http://localhost:3000 |
| `npm test` | Run all tests (about 1–2 minutes) |
| `npm run check` | Type-check + tests + production build — the "is everything fine?" command |
| `npm run gen:permissions` | Re-create `…0300_permission_seed.sql` after changing `src/lib/permissions/policy.ts` |
| `npm run gen:social` | Re-create `…0600_social_limits_seed.sql` after changing `src/lib/social/networks.ts` |

## Social publishing (Phase 3)

- Everything runs against a **sandbox provider** built into the app — an invented stand-in for
  Buffer. No real account, no login, no token, no network call. See `docs/BUFFER-GO-LIVE-DESIGN.md`
  for the (not-yet-approved, not-yet-built) plan for connecting a real Buffer account later.
- A **Client** can, by default, only look. If an Admin grants it, a Client can also write drafts
  and approve someone else's post — never their own. A Client can never schedule or publish,
  whatever permission is granted: publishing is a sensitive action, so it always needs an Admin.
- **Approving a post freezes its exact words** (a fingerprint of the channel, text and picture
  description). Editing anything already approved sends it back to Draft. Scheduling and
  publishing re-check the fingerprint, so text can never be swapped in after approval.
- **A post can be published at most once.** The server claims each attempt in a way only one
  worker can win, even if two run at the same time.
- **Going live is switched off.** `LIVE_SOCIAL_ENABLED` in `src/lib/social/sources.ts` is fixed to
  `false`, a test fails if any network code appears in the social folder, and the database itself
  refuses a `buffer` connection with a hard constraint.
- The page has a "Demo preview" switch (Admin / Client, view-only or allowed to write). It exists
  only in development builds.

## SEO / GEO audits (Phase 2)

- A **Client** can view audits, run audits (which only queue a request) and download the report. They have no way to change a website or apply a fix.
- An **Admin** can also record that a fix was applied (after a confirmation). This is logged. It never changes the website itself.
- Results are written only by the server; the database refuses them from anyone using the app.
- **Live website fetching is off.** `LIVE_AUDITS_ENABLED` in `src/lib/seo/sources.ts` is fixed to `false`, and a test fails if any network code appears in the audit folder. When live audits are approved, the address-safety guard (`safe-url.ts`) and a DNS check must be added to the live fetcher.
- The page has a "Demo preview" switch (Admin / Client). It exists only in development builds.

## How the permission rules are guarded

The rules live in one place — `src/lib/permissions/policy.ts` — and are copied into the database
by a generator, never by hand. A test runs **every** combination of role × module × action
through both the TypeScript rules and the real database rules and fails if they ever disagree.

## Keeping the design exactly the same

Tests fail if any of these change: `../interface/` (checked against the Phase 0 fingerprints in
`../backups/`), the approved CSS at the top of `globals.css`, or the structure/classes/text of the
dashboard compared with the approved `App.tsx` after the same clicks. The only visual differences
are below 1100 px wide (phones and tablets), where the approved design had no layout at all.

## Secrets

Copy `.env.example` to `.env.local` **yourself** when Supabase is connected in a later phase.
`.env.local` is git-ignored. The `SUPABASE_SERVICE_ROLE_KEY` must never be given to a browser,
a client user, or pasted into a chat.
