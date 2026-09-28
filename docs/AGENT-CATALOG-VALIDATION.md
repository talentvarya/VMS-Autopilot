# Agent catalog validation — full results

**Status: read-only checks only.** Nothing in this document changed a single file inside
`agency-agents/`. All five checks below are the catalog's own pre-existing scripts
(`agency-agents/scripts/`), run as-is, and their output is reported here verbatim/summarized —
nothing was edited to make a check pass. This is the deliverable for Phase 4's validation step;
see [AGENT-RUNTIME-ARCHITECTURE.md](./AGENT-RUNTIME-ARCHITECTURE.md) and
[AGENT-CATALOG-MAPPING.md](./AGENT-CATALOG-MAPPING.md) for the architecture and mapping halves
of Phase 4.

## Catalog inventory (verified counts)

| Count | What |
|---|---|
| 368 | total files under `agency-agents/` |
| 327 | `.md` files |
| **279** | valid agent-persona files (parsed and counted by `build-catalog.py --check`, across 18 canonical divisions) |
| 48 | `.md` files that are *not* agent entries (root docs, `strategy/` playbooks, `examples/`, `integrations/aider/CONVENTIONS.md`) |
| 41 | non-`.md` files (workflows, scripts, `LICENSE`, JSON configs) |

**279 is the authoritative persona count** — it supersedes an earlier "327 personas" estimate
given during pre-approval planning, which had not yet excluded the 48 non-agent `.md` files.

## Test 1 — `python3 scripts/build-catalog.py --check`

Validates that every agent file's frontmatter parses correctly and that the catalog is
internally consistent, without writing anything (`--check` is read-only).

```
PASSED: 279 agents across 18 divisions parse cleanly (--check: nothing written).
```

**Result: PASSED. Exit 0.**

## Test 2 — `bash scripts/lint-agents.sh`

Checks every agent file for required/recommended frontmatter fields and recommended body
sections (`Identity`, `Core Mission`, `Critical Rules`, etc.).

This test needed several attempts to complete in this Windows/Git-Bash environment — see
**Environment note** below — but a full, clean run across all 279 files eventually completed:

```
Linting 279 agent files...

WARN  engineering/engineering-multi-agent-systems-architect.md: missing recommended section 'Core Mission'
WARN  engineering/engineering-senior-developer.md: missing recommended section 'Core Mission'
WARN  marketing/marketing-content-creator.md: missing recommended section 'Core Mission'
WARN  marketing/marketing-content-creator.md: missing recommended section 'Critical Rules'
WARN  marketing/marketing-growth-hacker.md: missing recommended section 'Core Mission'
WARN  marketing/marketing-growth-hacker.md: missing recommended section 'Critical Rules'
WARN  marketing/marketing-social-media-strategist.md: missing recommended section 'Identity'
WARN  marketing/marketing-social-media-strategist.md: missing recommended section 'Core Mission'
WARN  marketing/marketing-social-media-strategist.md: missing recommended section 'Critical Rules'
WARN  paid-media/paid-media-auditor.md: missing recommended section 'Core Mission'
WARN  paid-media/paid-media-auditor.md: missing recommended section 'Critical Rules'
WARN  paid-media/paid-media-creative-strategist.md: missing recommended section 'Core Mission'
WARN  paid-media/paid-media-creative-strategist.md: missing recommended section 'Critical Rules'
WARN  paid-media/paid-media-paid-social-strategist.md: missing recommended section 'Core Mission'
WARN  paid-media/paid-media-paid-social-strategist.md: missing recommended section 'Critical Rules'
WARN  paid-media/paid-media-ppc-strategist.md: missing recommended section 'Core Mission'
WARN  paid-media/paid-media-ppc-strategist.md: missing recommended section 'Critical Rules'
WARN  paid-media/paid-media-programmatic-buyer.md: missing recommended section 'Core Mission'
WARN  paid-media/paid-media-programmatic-buyer.md: missing recommended section 'Critical Rules'
WARN  paid-media/paid-media-search-query-analyst.md: missing recommended section 'Core Mission'
WARN  paid-media/paid-media-search-query-analyst.md: missing recommended section 'Critical Rules'
WARN  paid-media/paid-media-tracking-specialist.md: missing recommended section 'Core Mission'
WARN  paid-media/paid-media-tracking-specialist.md: missing recommended section 'Critical Rules'
WARN  product/product-feedback-synthesizer.md: missing recommended section 'Core Mission'
WARN  product/product-feedback-synthesizer.md: missing recommended section 'Critical Rules'
WARN  product/product-sprint-prioritizer.md: missing recommended section 'Identity'
WARN  product/product-sprint-prioritizer.md: missing recommended section 'Core Mission'
WARN  product/product-sprint-prioritizer.md: missing recommended section 'Critical Rules'
WARN  product/product-trend-researcher.md: missing recommended section 'Core Mission'
WARN  product/product-trend-researcher.md: missing recommended section 'Critical Rules'
WARN  project-management/project-manager-senior.md: missing recommended section 'Core Mission'
WARN  sales/sales-deal-strategist.md: missing recommended section 'Identity'
WARN  sales/sales-deal-strategist.md: missing recommended section 'Core Mission'
WARN  sales/sales-deal-strategist.md: missing recommended section 'Critical Rules'
WARN  sales/sales-discovery-coach.md: missing recommended section 'Core Mission'
WARN  sales/sales-discovery-coach.md: missing recommended section 'Critical Rules'
WARN  sales/sales-engineer.md: missing recommended section 'Identity'
WARN  sales/sales-engineer.md: missing recommended section 'Core Mission'
WARN  sales/sales-engineer.md: missing recommended section 'Critical Rules'
WARN  sales/sales-outbound-strategist.md: missing recommended section 'Core Mission'
WARN  sales/sales-outbound-strategist.md: missing recommended section 'Critical Rules'
WARN  spatial-computing/terminal-integration-specialist.md: missing recommended section 'Core Mission'
WARN  spatial-computing/terminal-integration-specialist.md: missing recommended section 'Critical Rules'
WARN  spatial-computing/visionos-spatial-engineer.md: missing recommended section 'Core Mission'
WARN  spatial-computing/visionos-spatial-engineer.md: missing recommended section 'Critical Rules'
WARN  spatial-computing/xr-cockpit-interaction-specialist.md: missing recommended section 'Critical Rules'
WARN  spatial-computing/xr-immersive-developer.md: missing recommended section 'Critical Rules'
WARN  spatial-computing/xr-interface-architect.md: missing recommended section 'Critical Rules'
WARN  specialized/automation-governance-architect.md: missing recommended section 'Identity'
WARN  specialized/automation-governance-architect.md: missing recommended section 'Critical Rules'
WARN  specialized/chief-financial-officer.md: missing recommended section 'Core Mission'
WARN  specialized/data-privacy-officer.md: missing recommended section 'Core Mission'
WARN  specialized/esg-sustainability-officer.md: missing recommended section 'Core Mission'
WARN  specialized/ma-integration-manager.md: missing recommended section 'Core Mission'
WARN  specialized/operations-manager.md: missing recommended section 'Core Mission'
WARN  specialized/organizational-psychologist.md: missing recommended section 'Core Mission'
WARN  testing/testing-evidence-collector.md: missing recommended section 'Core Mission'
WARN  testing/testing-evidence-collector.md: missing recommended section 'Critical Rules'

Results: 0 error(s), 58 warning(s) in 279 files.
PASSED
```

**Result: PASSED. 0 errors, 58 warnings, 279/279 files checked. Exit 0.**

All 58 warnings are the same category — a persona file is missing one of the lint script's
*recommended* (not required) sections (`Identity`, `Core Mission`, or `Critical Rules`). None
are errors, and none block catalog use. No files were edited to clear these warnings, per the
read-only-validation scope of this phase.

**Environment note (Windows/Git-Bash only, not a catalog defect):** running this script against
all 279 files spawns many short-lived subprocesses (one per file, for several checks each), and
on this Windows/Git-Bash setup that made the *first few* full-sweep attempts appear to hang or
get silently backgrounded by the shell tooling before finishing — even though, when tested
individually, every candidate file lints instantly and cleanly. The run above is a genuine
complete pass, not a workaround or a partial result. This is worth remembering only if the
catalog is linted again from a similar Windows environment — the script itself is fine.

## Test 3 — `bash scripts/check-divisions.sh`

Confirms every division present in `divisions.json` (the source of truth) matches the division
folders that actually exist on disk.

```
ERROR the agent directories on disk has division(s) not in divisions.json: site
FAILED: 1 divisions consistency error(s). divisions.json is the source of truth.
```

**Result: FAILED. Exit 1. This is a genuine, pre-existing finding — not something this project
introduced, and not fixed in this phase** (fixing it would mean editing a vendored, upstream
catalog script — out of scope for "validation and documentation only").

**Root cause:** the catalog ships a `site/` directory (a GitHub Pages template — just
`site/index.html`) that is registered neither as a division in `divisions.json` nor in
`check-divisions.sh`'s own exclusion list (`NON_DIVISION_DIRS=(examples scripts integrations
strategy)`, which was clearly meant to cover exactly this kind of non-division folder but was
never updated when `site/` was added). It is a one-line fix in the upstream script
(add `site` to `NON_DIVISION_DIRS`), but making that edit is outside this phase's declared scope,
so it is reported here as a finding for a future phase instead.

## Test 4 — `bash scripts/check-tools.sh`

Confirms the tool list is identical across `tools.json`, `install.sh`, and `convert.sh`.

```
PASSED: 16 tools consistent across tools.json, install.sh, and convert.sh.
```

**Result: PASSED. Exit 0.**

## Test 5 — `bash scripts/check-agent-originality.sh` (audit mode)

Compares every persona file's text against a baseline of well-known public agent-prompt
libraries to flag suspiciously high overlap (i.e., a persona that may have been copied rather
than authored).

**First attempt crashed**, not because of a catalog problem but because of this Windows
environment's default text encoding:

```
UnicodeDecodeError: 'charmap' codec can't decode byte 0x8d in position 232
```

This happened while the script was reading one of the catalog's China-market marketing persona
files, which contain non-Latin1 (Chinese-language) text; Windows' default `cp1252` codepage
cannot decode it, while the file itself is valid UTF-8.

**Fix:** re-ran with explicit UTF-8 environment variables (`PYTHONUTF8=1`,
`PYTHONIOENCODING=utf-8`) — a read-only environment setting, no catalog file was touched.
The retry completed cleanly:

```
[... 452 lines of per-file similarity results ...]
Thresholds: WARN >= 20%, FAIL >= 40%
... PASSED
```

Zero `WARN` or `FAIL` entries across all files (confirmed by grep over the full output) —
consistent with the script's own documented baseline that an original catalog should show at
most ~1.5% similarity to the reference libraries.

**Result: PASSED after correcting for a Windows-only encoding issue. Exit 0.**

## Summary

| # | Test | Result | Exit code |
|---|---|---|---|
| 1 | `build-catalog.py --check` | PASSED (279 agents, 18 divisions) | 0 |
| 2 | `lint-agents.sh` | PASSED (0 errors, 58 warnings) | 0 |
| 3 | `check-divisions.sh` | **FAILED** (`site/` dir not registered) | 1 |
| 4 | `check-tools.sh` | PASSED (16 tools consistent) | 0 |
| 5 | `check-agent-originality.sh` | PASSED (0 WARN/FAIL, after UTF-8 fix) | 0 |

**4 of 5 checks pass cleanly. 1 genuine, pre-existing, low-severity finding** (Test 3 — the
`site/` GitHub Pages template folder isn't registered as a non-division directory) is reported
here rather than fixed, since fixing it would mean editing the vendored catalog's own scripts,
which is outside this phase's "validation and documentation only" scope. No agent file was
edited, no API key was created, no account was connected, and the approved dashboard interface
was not touched by any of this work.
