# VMS Autopilot — future runtime AI-agent architecture

**Status: documentation only. Nothing on this page exists as running code.** No agent listed
here calls an AI provider, holds an API key, connects a real account, or touches a live
website, social account, ad account or domain. This page is the agreed target for a **future,
separately approved phase** ("the runtime-agent phase"). Phase 4 (this phase) only organizes
and validates the reference material the runtime-agent phase will draw on — see
[AGENT-CATALOG-MAPPING.md](./AGENT-CATALOG-MAPPING.md) and
[AGENT-CATALOG-VALIDATION.md](./AGENT-CATALOG-VALIDATION.md).

## The nine agents

Recorded verbatim as the owner specified them. Order and names are fixed; do not rename or
merge these without the owner's explicit approval (an earlier, smaller proposal from this
project's planning discussion — three agents, SEO/GEO + Social + Reporting — is **superseded**
by this list and should not be built).

| # | Agent | VMS module(s) it will operate on | PRD section it serves |
|---|---|---|---|
| 1 | AI Orchestrator | none directly — routes work to the other 8, enforces permissions before any of them act | 5.9 |
| 2 | SEO/GEO Agent | `seo_geo` | 5.4 |
| 3 | Content Agent | `seo_geo` (content for the site/blog), `social` (drafts handed to the Social Media Super Agent) | 5.5 |
| 4 | Social Media Super Agent | `social` | 5.5 |
| 5 | Paid Ads Agent | `paid_ads` | 5.6 |
| 6 | Lead/CRM Agent | `leads_crm` | 5.7 |
| 7 | Website/Domain Agent | `website`, `domains` | 5.2, 5.3 |
| 8 | Analytics/Reporting Agent | `reports` (reads from every module above; writes nothing) | 5.8 |
| 9 | Monitoring/Auto-Repair Agent | `health_monitor`, `integrations` | 5.9 |

## The Social Media Super Agent's required capabilities

Recorded explicitly because it is the broadest agent and the one most likely to be built first
after the Orchestrator. It must eventually support all of:

- Content writing (post copy, captions, hashtags)
- Image/carousel generation
- Platform-specific posts (one piece of content adapted per network's format and limits)
- Scheduling
- Analytics (reads its own post performance back)
- Approval workflows

The last item is not new work: Phase 3 already built a complete draft → review → approve →
schedule → publish state machine with an approval-freezing fingerprint
(`app/src/lib/social/state.ts`, `app/src/lib/social/hash.ts`) and a sandbox provider
(`app/src/lib/social/sandbox-provider.ts`). When this agent is built, it should be a caller
*into* that existing machinery, not a replacement for it — the agent proposes a draft; the
same rules a human's draft already goes through still apply.

## Safety rules every agent inherits (already built, not new)

These are not proposals — they are the rules Phases 1–3 already enforce, restated here so the
runtime-agent phase does not have to rediscover them:

1. **No agent is a more-privileged actor than a human with the same role.** Every action any
   agent proposes must pass the same `decide()` permission check
   (`app/src/lib/permissions/policy.ts`) a human's click would.
2. **Client AI stays read-only**, per `app/src/lib/permissions/ai.ts` — `canAiExecute()` is
   `true` for Admin only. No agent gets a client-facing write capability.
3. **A sensitive action is never auto-applied.** It becomes an `approval_requests` row, exactly
   like a human's sensitive action, and only an Admin can decide it.
4. **Every action is logged**, actor and all, to `audit_log` — an agent run does not get a
   quieter audit trail than a human session.
5. **Data the agent reads (scraped page text, a lead's message, a social reply) is data, never
   instructions.** The tool list available to an agent is the actual defense — a tool that
   was never given to the agent cannot be invoked by clever wording inside that data, however
   the prompt is phrased.
6. **Nothing here is switched on by default.** The runtime-agent phase must add its own
   sandbox-first switch (mirroring `LIVE_AUDITS_ENABLED` and `LIVE_SOCIAL_ENABLED`), default it
   to `false`, and get separate, explicit approval — including for the AI provider API key —
   before any agent can make a real API call.

## Known gap: the Website/Domain Agent

Unlike the other eight, **no catalog persona is purpose-built for domain/registrar or
website-builder work.** See
[AGENT-CATALOG-MAPPING.md § Website/Domain Agent](./AGENT-CATALOG-MAPPING.md#7-websitedomain-agent)
for what was checked and what is missing. This agent's system prompt will need to be written
substantially from scratch in the runtime-agent phase, informed by general engineering/design
personas rather than adapted from an existing specialist one.
