/**
 * The Website/Domain Agent's own logic (Sub-phase E). Written from scratch, informed by PRD
 * 5.2/5.3 - as documented in Phase 4's docs/AGENT-CATALOG-MAPPING.md, no purpose-built
 * domain-registrar or website-builder persona exists anywhere in the agency-agents catalog.
 *
 * A Client's ceiling for the `website` module is 'view' only (Phase 1, unchanged) - drafting a
 * plan can never be attempted by a Client, however it is granted, by construction. Domain
 * research (name suggestions, availability) is NOT written to any table - it is pure,
 * input-driven computation, recorded only in this run's own agent_runs.output, the same
 * reasoning that keeps research_strategy from persisting anything in Sub-phase B. A real
 * domain connection (`propose_domain_connection`) has NO apply() - no registrar integration
 * exists, so proposing it only ever proves the permission/approval path.
 */

import type { AgentLogicResult, AgentStore, Handoff, Principal, ProposedToolCall, WebsitePage, WebsiteProvider } from '../types';

export type WebsiteAgentInput =
  | { task: 'draft_website_plan'; workspaceId: string; provider: WebsiteProvider; title: string; pages: WebsitePage[]; submitForReview?: boolean }
  | { task: 'research_domain_names'; businessName: string; keywords?: string[] }
  | { task: 'check_domain_availability'; candidates: string[] }
  | { task: 'propose_domain_connection'; workspaceId: string; domain: string };

/** Sandbox-only: a small, fixed "already taken" list - never a real WHOIS/registrar call. */
const KNOWN_TAKEN = new Set(['example.com', 'test.com', 'nova-clinic.com']);

export function suggestDomainNames(businessName: string, keywords: string[] = []): string[] {
  const base = businessName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const extras = keywords.map((k) => k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')).filter(Boolean);
  const stems = [base, `get${base}`, ...extras.map((k) => `${base}${k}`)].filter(Boolean);
  const extensions = ['com', 'co', 'io'];
  const suggestions: string[] = [];
  for (const stem of stems.slice(0, 3)) {
    for (const ext of extensions) suggestions.push(`${stem}.${ext}`);
  }
  return suggestions;
}

export function checkDomainAvailability(candidates: string[]): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const candidate of candidates) result[candidate] = !KNOWN_TAKEN.has(candidate.trim().toLowerCase());
  return result;
}

export async function runWebsiteAgent(input: WebsiteAgentInput, store: AgentStore, principal: Principal): Promise<AgentLogicResult> {
  const toolCalls: ProposedToolCall[] = [];
  const handoffs: Handoff[] = [];
  let output: Record<string, unknown> = {};

  if (input.task === 'draft_website_plan') {
    let createdId: string | null = null;
    toolCalls.push({
      toolName: 'draft_website_plan',
      toolInput: { provider: input.provider, title: input.title, pageCount: input.pages.length },
      permission: { module: 'website', action: 'create' },
      apply: async () => {
        if (!store.draftWebsitePlan) throw new Error('this store cannot draft a website plan');
        const { id } = await store.draftWebsitePlan(principal, { workspaceId: input.workspaceId, provider: input.provider, title: input.title, pages: input.pages });
        createdId = id;
        return { projectId: id };
      },
    });
    if (input.submitForReview) {
      toolCalls.push({
        toolName: 'submit_website_plan_for_review',
        toolInput: {},
        permission: { module: 'website', action: 'create' },
        apply: async () => {
          if (!createdId) throw new Error('the website plan was never created, so it cannot be submitted for review');
          if (!store.submitWebsitePlanForReview) throw new Error('this store cannot submit website plans for review');
          await store.submitWebsitePlanForReview(principal, createdId);
          return { projectId: createdId, submitted: true };
        },
      });
    }
  } else if (input.task === 'research_domain_names') {
    const suggestions = suggestDomainNames(input.businessName, input.keywords);
    toolCalls.push({ toolName: 'research_domain_names', toolInput: { businessName: input.businessName } });
    output = { suggestions };
  } else if (input.task === 'check_domain_availability') {
    const availability = checkDomainAvailability(input.candidates);
    toolCalls.push({ toolName: 'check_domain_availability', toolInput: { candidateCount: input.candidates.length } });
    output = { availability };
  } else if (input.task === 'propose_domain_connection') {
    toolCalls.push({
      toolName: 'propose_domain_connection',
      toolInput: { domain: input.domain },
      permission: { module: 'domains', action: 'create' },
      // No apply() - no registrar integration exists. Proposing it only ever proves the
      // permission/approval path; nothing is ever connected.
    });
    output = { note: 'connecting a domain is not implemented - no registrar integration exists' };
  }

  return { output, toolCalls, handoffs };
}
