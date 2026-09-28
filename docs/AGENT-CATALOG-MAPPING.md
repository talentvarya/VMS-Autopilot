# Catalog-to-agent mapping

**Status: documentation only.** This maps existing `agency-agents/` persona files to the nine
future runtime agents recorded in
[AGENT-RUNTIME-ARCHITECTURE.md](./AGENT-RUNTIME-ARCHITECTURE.md). No persona file listed here
has been edited, executed, or called through any API. "Primary" means the closest existing
match to build a future system prompt from; "supplementary" means a second file worth drawing
on for one specific capability. Descriptions below are quoted from each file's own frontmatter
`description:` field, read directly — not paraphrased from memory.

Of the catalog's 279 valid agent files (per `build-catalog.py --check` — see
[AGENT-CATALOG-VALIDATION.md](./AGENT-CATALOG-VALIDATION.md)), the personas named below are the
ones actually relevant to a marketing agency's own operations. The remaining files (academic,
GIS, game development, healthcare, legal, finance-for-its-own-sake, and most of `specialized/`)
have no VMS Autopilot task to attach to and are not listed here — that is expected, not an
oversight, and is not a defect in the catalog.

## 1. AI Orchestrator

No persona plays this role directly — it is new infrastructure (task routing, permission
enforcement before any sub-agent acts, context assembly), not a marketing specialist.

**Reference only** (inform *how* it is built, not *what* it says):
- `engineering/engineering-multi-agent-systems-architect.md` — "Systems architect specializing
  in the design, coordination, and governance of multi-agent AI pipelines — covering topology
  selection, context management, inter-agent trust, failure recovery, human-in-the-loop
  gating, and observability for production-grade agent systems."
- `engineering/engineering-prompt-engineer.md` — prompt design and evaluation.

## 2. SEO/GEO Agent

Maps to the already-built `seo_geo` module (Phase 2).

| File | Description (verbatim) |
|---|---|
| `marketing/marketing-seo-specialist.md` (primary) | "Expert search engine optimization strategist specializing in technical SEO, content optimization, link authority building, and organic search growth. Drives sustainable traffic through data-driven search strategies." |
| `marketing/marketing-aeo-foundations.md` (supplementary — GEO infrastructure) | "Expert in AI Engine Optimization infrastructure — implements llms.txt, AI-aware robots.txt, token-budgeted content, structured Markdown availability, and agent discovery files so AI crawlers, citation engines, and browsing agents can find, parse, and act on your site" |
| `marketing/marketing-ai-citation-strategist.md` (supplementary — GEO/citations) | "Expert in AI recommendation engine optimization (AEO/GEO) — audits brand visibility across ChatGPT, Claude, Gemini, and Perplexity, identifies why competitors get cited instead, and delivers content fixes that improve AI citations" |

This division is a strong, direct match — the Phase 2 audit engine's own category list (technical, on-page, mobile, performance, local, GEO) lines up closely with what these three personas already cover.

## 3. Content Agent

Maps to `seo_geo` (site/blog content) and hands drafts to the Social Media Super Agent for
platform-specific adaptation.

| File | Description (verbatim) |
|---|---|
| `marketing/marketing-content-creator.md` (primary) | "Expert content strategist and creator for multi-platform campaigns. Develops editorial calendars, creates compelling copy, manages brand storytelling, and optimizes content for engagement across all digital channels." |

**Overlap note:** this file's own description already spans "multi-platform campaigns," which
is also the Social Media Super Agent's territory. The runtime-agent phase will need to decide
the exact boundary — my suggestion (to confirm later, not decided now) is: Content Agent
produces the underlying idea/copy/calendar; Social Media Super Agent adapts and executes it
per network.

## 4. Social Media Super Agent

The broadest of the nine, per the owner's explicit requirement to cover content writing,
image/carousel generation, platform-specific posts, scheduling, analytics and approval
workflows. Draws on the most personas of any agent.

| File | Description (verbatim) | Covers |
|---|---|---|
| `marketing/marketing-social-media-strategist.md` (primary) | "Expert social media strategist for LinkedIn, Twitter, and professional platforms. Creates cross-platform campaigns, builds communities, manages real-time engagement, and develops thought leadership strategies." | General strategy |
| `marketing/marketing-carousel-growth-engine.md` | "Autonomous TikTok and Instagram carousel generation specialist. Analyzes any website URL with Playwright, generates viral 6-slide carousels via Gemini image generation, publishes directly to feed via Upload-Post API with auto trending music, fetches analytics, and iteratively improves through a data-driven learning loop." | Image/carousel generation — a direct, unusually specific match for this requirement. **Note:** this persona's own description assumes live, automated publishing with no approval step; the runtime-agent phase must route any output through the existing Phase 3 approval flow instead of following this persona's assumption literally. |
| `design/design-image-prompt-engineer.md` | "Expert photography prompt engineer specializing in crafting detailed, evocative prompts for AI image generation. Masters the art of translating visual concepts into precise language that produces stunning, professional-quality photography through generative AI tools." | Image generation prompts |
| `marketing/marketing-instagram-curator.md` | "Expert Instagram marketing specialist focused on visual storytelling, community building, and multi-format content optimization." | Platform-specific: Instagram |
| `marketing/marketing-tiktok-strategist.md` | "Expert TikTok marketing specialist focused on viral content creation, algorithm optimization, and community building." | Platform-specific: TikTok |
| `marketing/marketing-twitter-engager.md` | "Expert Twitter marketing specialist focused on real-time engagement, thought leadership building, and community-driven growth." | Platform-specific: X/Twitter |
| `marketing/marketing-linkedin-content-creator.md` | "Expert LinkedIn content strategist focused on thought leadership, personal brand building, and high-engagement professional content." | Platform-specific: LinkedIn |
| `marketing/marketing-multi-platform-publisher.md` | "Expert orchestrator for one-click ... publishing. Routes a single article to [multiple platforms] ... Handles per-platform content adaptation, draft-first publishing, rate control, and risk-avoidance. **Does NOT auto-publish — always stops at draft for human review.**" | Scheduling/cross-posting orchestration. Worth noting this persona already models "stop at draft for review" as its own design principle — it agrees with, rather than fights, the existing Phase 3 approval requirement. |

**Analytics and approval workflows are not separate personas** — analytics reuses the Analytics/
Reporting Agent (item 8 below) rather than duplicating it, and approval workflows reuse the
`approval_requests` mechanism Phase 3 already built, not a new persona.

## 5. Paid Ads Agent

Maps to the `paid_ads` module (not yet built). All 7 files in `paid-media/` map cleanly — this
division is a complete, one-to-one fit with no leftover or missing files.

| File | Description (verbatim) |
|---|---|
| `paid-media/paid-media-ppc-strategist.md` | "Senior paid media strategist specializing in large-scale search, shopping, and performance max campaign architecture across Google, Microsoft, and Amazon ad platforms." |
| `paid-media/paid-media-paid-social-strategist.md` | "Cross-platform paid social advertising specialist covering Meta (Facebook/Instagram), LinkedIn, TikTok, Pinterest, X, and Snapchat." |
| `paid-media/paid-media-creative-strategist.md` | "Paid media creative specialist focused on ad copywriting, RSA optimization, asset group design, and creative testing frameworks." |
| `paid-media/paid-media-tracking-specialist.md` | "Expert in conversion tracking architecture, tag management, and attribution modeling across Google Tag Manager, GA4, Google Ads, Meta CAPI, LinkedIn Insight Tag." |
| `paid-media/paid-media-auditor.md` | "Comprehensive paid media auditor who systematically evaluates Google Ads, Microsoft Ads, and Meta accounts across 200+ checkpoints." |
| `paid-media/paid-media-search-query-analyst.md` | "Specialist in search term analysis, negative keyword architecture, and query-to-intent mapping." |
| `paid-media/paid-media-programmatic-buyer.md` | "Display advertising and programmatic media buying specialist covering managed placements, Google Display Network, DV360, trade desk platforms." |

Matches the PRD's own phase order for this module (Google Ads and Meta Ads first, other
networks later): the PPC and Paid Social files cover exactly that pairing, with the rest
mapping to later capabilities in the same PRD section.

## 6. Lead/CRM Agent

Maps to the `leads_crm` module (not yet built). Draws mainly from `sales/`, with a few relevant
files from `specialized/`.

| File | Description (verbatim) |
|---|---|
| `sales/sales-offer-lead-gen-strategist.md` (primary) | "Top-of-funnel architect who designs irresistible offers and lead magnets that attract qualified buyers at scale... multi-channel lead generation..." |
| `sales/sales-outbound-strategist.md` | "Signal-based outbound specialist who designs multi-channel prospecting sequences, defines ICPs, and builds pipeline through research-driven personalization." |
| `sales/sales-pipeline-analyst.md` | "Revenue operations analyst specializing in pipeline health diagnostics, deal velocity analysis, forecast accuracy... Turns CRM data into actionable pipeline intelligence." |
| `specialized/sales-data-extraction-agent.md` | "AI agent specialized in monitoring Excel files and extracting key sales metrics (MTD, YTD, Year End) for internal live reporting" |
| `specialized/data-consolidation-agent.md` | "AI agent that consolidates extracted sales data into live reporting dashboards with territory, rep, and pipeline summaries" |
| `specialized/customer-success-manager.md` | Post-conversion relationship and retention management. |

Maps to PRD 5.7 (lead inbox, notes/tasks, follow-up automations). The remaining `sales/` files
not listed here (`sales-coach.md`, `sales-deal-strategist.md`, `sales-discovery-coach.md`,
`sales-engineer.md`, `sales-account-strategist.md`, `sales-proposal-strategist.md`) are aimed at
a B2B sales team's own coaching and deal process rather than an agency managing *its clients'*
lead pipelines — noted here so it's clear they were considered, not missed.

## 7. Website/Domain Agent

**No purpose-built persona exists for this agent.** This is a genuine gap in the catalog, not
an oversight in this mapping exercise — `agency-agents/` has no domain-registrar or
website-builder-specific persona anywhere in its 279 files. The closest available material is
generic engineering/design personas that would need to be substantially rewritten, not adapted:

| File | Description (verbatim) | Why it's only a partial fit |
|---|---|---|
| `engineering/engineering-frontend-developer.md` | General frontend implementation | Not domain/DNS/registrar-aware at all |
| `engineering/engineering-cms-developer.md` | CMS/website content work | Same gap |
| `design/design-ui-designer.md` | Visual design systems | Design only, no domain or hosting knowledge |

**Recommendation for the runtime-agent phase:** write this agent's persona from scratch,
informed by the PRD's own module descriptions (5.2 Website studio, 5.3 Domain module) rather
than adapted from an existing catalog file.

## 8. Analytics/Reporting Agent

Maps to the `reports` module (not yet built) — and, per the architecture doc, this agent is
**read-only**: it summarizes data other modules already hold, and proposes nothing for
approval.

| File | Description (verbatim) |
|---|---|
| `support/support-analytics-reporter.md` (primary) | "Expert data analyst transforming raw data into actionable business insights. Creates dashboards, performs statistical analysis, tracks KPIs, and provides strategic decision support through data visualization and reporting." |
| `support/support-executive-summary-generator.md` | "Consultant-grade AI specialist... Transforms complex business inputs into concise, actionable executive summaries using McKinsey SCQA, BCG Pyramid Principle, and Bain frameworks." |
| `specialized/report-distribution-agent.md` | "AI agent that automates distribution of consolidated sales reports to representatives based on territorial parameters" |

Matches PRD 5.8 (client-safe dashboards, daily/weekly/monthly summaries, PDF/CSV export).

## 9. Monitoring/Auto-Repair Agent

Maps to `health_monitor` and `integrations` — matches PRD 5.9's 24-hour health monitor and
"Admin AI can retry failed jobs and restart safe workflows."

| File | Description (verbatim) |
|---|---|
| `engineering/engineering-sre.md` (primary) | "Expert site reliability engineer specializing in SLOs, error budgets, observability, chaos engineering, and toil reduction for production systems at scale." |
| `engineering/engineering-incident-response-commander.md` | "Expert incident commander specializing in production incident management, structured response coordination, post-mortem facilitation, SLO/SLI tracking, and on-call process design." |
| `security/security-incident-responder.md` | "Digital forensics and incident response specialist who leads breach investigations, contains active threats, coordinates crisis response, and writes post-mortems." |
| `testing/testing-reality-checker.md` | "Stops fantasy approvals, evidence-based certification — Default to 'NEEDS WORK', requires overwhelming proof for production readiness" — a useful check against an auto-repair agent that is too eager to mark something fixed. |
| `engineering/engineering-devops-automator.md` | "Expert DevOps engineer specializing in infrastructure automation, CI/CD pipeline development, and cloud operations" |

**Non-negotiable inherited rule** (from `AGENT-RUNTIME-ARCHITECTURE.md`): "automatic repair
must be limited to safe, reversible actions... All repairs must be logged and notify the
Admin" (PRD 5.9). None of the personas above override that; it constrains how they must be
adapted.

## Summary table

| # | Agent | Match quality | Files identified |
|---|---|---|---|
| 1 | AI Orchestrator | No direct persona — infrastructure | 2 reference files |
| 2 | SEO/GEO Agent | Strong | 3 |
| 3 | Content Agent | Strong, with an overlap to resolve | 1 |
| 4 | Social Media Super Agent | Strong, most files of any agent | 8 |
| 5 | Paid Ads Agent | Strong — whole division maps 1:1 | 7 |
| 6 | Lead/CRM Agent | Strong | 6 |
| 7 | Website/Domain Agent | **Weak — no purpose-built persona exists** | 3 partial-fit references only |
| 8 | Analytics/Reporting Agent | Strong | 3 |
| 9 | Monitoring/Auto-Repair Agent | Strong | 5 |
