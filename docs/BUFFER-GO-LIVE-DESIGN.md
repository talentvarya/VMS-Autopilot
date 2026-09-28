# Buffer go-live design (NOT built, NOT approved)

**Status: a plan only.** Phase 3 runs entirely on a sandbox. Nothing in this project connects to Buffer, to any social network, or holds any token. This note explains what would have to happen, in what order, if you decide to connect real accounts. Nothing here starts until you say so.

> Buffer's programme, plans and limits change. Before any work, the current Buffer developer documentation must be read and this note updated. Numbers below are examples, not facts about Buffer.

## What already protects you (built and tested in Phase 3)

| Protection | Where it lives |
|---|---|
| Real connections are switched off | `LIVE_SOCIAL_ENABLED = false` in `src/lib/social/sources.ts`, plus a test that fails if any network code appears in `src/lib/social/` |
| The database refuses a Buffer connection | Constraint `social_sandbox_only` in migration `…0500_social.sql` |
| A social profile can be connected only once, anywhere | `unique (network, external_id)` on `social_channels` |
| A workspace cannot exceed its plan's channel limit | Trigger on `social_channels` (the limit comes from the provider) |
| Nothing publishes without approval, and approval freezes the exact words | Post life-cycle trigger + fingerprint check, twice (database and worker) |
| A Client can never publish | Permission ceiling; scheduling and publishing are Admin-only |
| A post is published at most once | Attempt claim (`unique (post, attempt)`) + one idempotency key per post |
| Every step is recorded, and the words are not copied into the log | Audit triggers |

## Steps to go live (each needs your explicit approval)

1. **Decide the scope.** Which client, which channels, a test account first. Never start with a real client.
2. **Create a Buffer developer application** under an agency-owned Buffer account, with the minimum permissions. Record the application's identifier only. **Keys and secrets are never pasted into chat or into files**; you type them yourself into the secret store.
3. **Secret storage.** Tokens live in Supabase Vault (or another secret manager). The database keeps only a *reference* (`integration_credentials.secret_ref`), which no logged-in user can read. Tokens never reach the browser, the audit log or any error message.
4. **Connect flow (OAuth).**
   - The Admin presses "Connect Buffer" for one client workspace.
   - We create a random `state` value that is single-use, expires in about ten minutes, and is tied to that Admin and that workspace.
   - Buffer shows its own consent screen to the account owner.
   - Buffer sends the browser back to our callback with a code and the `state`.
   - Our server checks the `state` (wrong, expired or reused = stop), exchanges the code for tokens **on the server**, stores them in the secret store, and records who consented and when (`integrations.consent_*`).
   - Only the server can mark an integration "connected". The app cannot forge it.
5. **Channels.** After connecting, the server reads the channel list and plan from Buffer. Each profile becomes one `social_channels` row. If a profile is already connected anywhere on the platform, it is refused. The plan's channel limit is copied from Buffer, never invented.
6. **A new migration** (separate, reviewed) replaces the `social_sandbox_only` constraint so `buffer` is allowed. Until then the database itself says no.
7. **A `BufferProvider`** is written to the same `SocialProvider` interface as the sandbox, and the switch is turned on for the chosen workspace only.
8. **Dry run first.** Publish to throw-away test profiles. Confirm: a post appears once, a retry after a timeout does not post twice, a rate-limit is handled, an expired token turns the channel to "Needs reconnecting" and tells the Admin.
9. **Go live for one real client**, with the Admin watching, then widen.

## Things to check in Buffer's rules before building

- Whether Buffer's API supports an idempotency key. If not, after an unknown result the worker must **look up recent posts before retrying**, so nothing is posted twice.
- Which networks and post types the API can publish (pictures and video need an upload step that Phase 3 does not have).
- Rate limits and how "too many requests" is reported.
- Whether a scheduled post is stored by Buffer (we hand over the time) or by us (we publish at the time). Phase 3 assumes **we** decide the moment, which is the safer default.
- What happens to a client's connection if they change their Buffer password or remove our app.

## Consent and disconnecting

- The client (or the account owner) must agree before anything connects. The agreement is recorded with the person and the time.
- Disconnecting removes the stored tokens, marks the channels "Disconnected" (which frees the plan slot), keeps the history, and is logged.

## Open questions for you

1. Which Buffer account will own the developer application?
2. Do clients connect their own social accounts, or does the agency?
3. Free or paid Buffer plan to start with?
4. Are pictures and video needed before the first real client?
