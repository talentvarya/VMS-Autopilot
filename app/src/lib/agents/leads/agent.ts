/**
 * The Lead/CRM Agent's own logic (Sub-phase E). leads_crm is the lightest-touch module in the
 * whole system - Phase 1 never made creating or qualifying a lead sensitive (only delete is,
 * the universal rule) - so this file follows that real shape rather than inventing extra
 * gates. There is NO send tool anywhere: a drafted follow-up is text that sits in
 * lead_activities forever until a human sends it some other way - "any contact or follow-up
 * message must use the existing approval flow" is true by construction, since no code path
 * here ever dispatches anything.
 */

import type {
  AgentLogicResult,
  AgentStore,
  Handoff,
  LeadStatus,
  Principal,
  ProposedToolCall,
} from '../types';

export type LeadsAgentInput =
  | { task: 'capture_lead'; workspaceId: string; source: 'form' | 'whatsapp' | 'social_dm' | 'manual'; name?: string; contact?: string; notes?: string; sourceInteractionId?: string | null }
  | { task: 'qualify_lead'; workspaceId: string; leadId: string; status: LeadStatus }
  | { task: 'draft_follow_up'; workspaceId: string; leadId: string; context?: string }
  | { task: 'capture_lead_from_interaction'; workspaceId: string; interactionId: string; extractedContact?: string; confidence?: number };

const KNOWN_TASKS = new Set(['capture_lead', 'qualify_lead', 'draft_follow_up', 'capture_lead_from_interaction']);

/**
 * Sub-phase B's `propose_lead_handoff` handoff (`{interactionId, extractedContact?,
 * confidence?}`, no `task` field - the SAME payload shape it has always emitted, unchanged)
 * predates the task convention. This is the ONE, narrowly-scoped compatibility rule for it,
 * approved explicitly:
 *   - applies ONLY to this exact documented shape: task absent AND interactionId a string;
 *   - interactionId is REQUIRED (it is the one field Sub-phase B's emitter always includes);
 *   - extractedContact/confidence stay OPTIONAL, matching the emitter's own type exactly, but
 *     must be correctly typed if present - a wrong type is rejected, not coerced;
 *   - maps to capture_lead_from_interaction, which creates or updates (never duplicates) a
 *     lead linked back to that interaction, under the SAME leads_crm:create permission a
 *     normal capture_lead already uses - nothing about this path is more permissive;
 *   - never sends anything - there is no send tool in this file at all;
 *   - workspaceId is required too: the Orchestrator's handoff resolution (orchestrator.ts)
 *     always injects it, so its absence means this was not actually reached via a handoff.
 * Anything else - a missing interactionId, a wrong-typed optional field, or an unrecognized
 * task name - is rejected outright, not silently patched.
 */
function normalizeInput(raw: unknown): LeadsAgentInput {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('the Lead/CRM Agent needs an object as input');
  }
  const input = raw as Record<string, unknown>;

  if (input.task === undefined) {
    if (typeof input.interactionId !== 'string' || input.interactionId.length === 0) {
      throw new Error('input has no "task" and is not a recognizable propose_lead_handoff payload (needs a non-empty string "interactionId")');
    }
    if (typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
      throw new Error('a legacy propose_lead_handoff payload needs a workspaceId (the Orchestrator should have injected it)');
    }
    if (input.extractedContact !== undefined && typeof input.extractedContact !== 'string') {
      throw new Error('propose_lead_handoff: "extractedContact", if present, must be a string');
    }
    if (input.confidence !== undefined && typeof input.confidence !== 'number') {
      throw new Error('propose_lead_handoff: "confidence", if present, must be a number');
    }
    return {
      task: 'capture_lead_from_interaction',
      workspaceId: input.workspaceId,
      interactionId: input.interactionId,
      extractedContact: input.extractedContact as string | undefined,
      confidence: input.confidence as number | undefined,
    };
  }

  if (typeof input.task !== 'string' || !KNOWN_TASKS.has(input.task)) {
    throw new Error(`unknown Lead/CRM Agent task: "${String(input.task)}"`);
  }
  if (typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
    throw new Error(`${input.task} needs a workspaceId`);
  }

  switch (input.task) {
    case 'capture_lead': {
      const validSources = ['form', 'whatsapp', 'social_dm', 'manual'];
      if (typeof input.source !== 'string' || !validSources.includes(input.source)) {
        throw new Error('capture_lead needs a "source" of form, whatsapp, social_dm or manual');
      }
      return {
        task: 'capture_lead',
        workspaceId: input.workspaceId,
        source: input.source as 'form' | 'whatsapp' | 'social_dm' | 'manual',
        name: input.name as string | undefined,
        contact: input.contact as string | undefined,
        notes: input.notes as string | undefined,
        sourceInteractionId: input.sourceInteractionId as string | null | undefined,
      };
    }
    case 'qualify_lead':
      if (typeof input.leadId !== 'string' || typeof input.status !== 'string') throw new Error('qualify_lead needs a "leadId" and a "status"');
      return { task: 'qualify_lead', workspaceId: input.workspaceId, leadId: input.leadId, status: input.status as LeadStatus };
    case 'draft_follow_up':
      if (typeof input.leadId !== 'string') throw new Error('draft_follow_up needs a "leadId"');
      return { task: 'draft_follow_up', workspaceId: input.workspaceId, leadId: input.leadId, context: input.context as string | undefined };
    case 'capture_lead_from_interaction':
      if (typeof input.interactionId !== 'string') throw new Error('capture_lead_from_interaction needs an "interactionId"');
      return { task: 'capture_lead_from_interaction', workspaceId: input.workspaceId, interactionId: input.interactionId, extractedContact: input.extractedContact as string | undefined, confidence: input.confidence as number | undefined };
    default:
      throw new Error(`unknown Lead/CRM Agent task: "${String(input.task)}"`);
  }
}

function draftFollowUpBody(context?: string): string {
  return context
    ? `Thanks for reaching out! ${context.trim()} A member of our team will follow up shortly.`
    : "Thanks for reaching out! We'll follow up with you shortly.";
}

export async function runLeadsAgent(rawInput: unknown, store: AgentStore, principal: Principal): Promise<AgentLogicResult> {
  const input = normalizeInput(rawInput);
  const toolCalls: ProposedToolCall[] = [];
  const handoffs: Handoff[] = [];
  let output: Record<string, unknown> = {};

  if (input.task === 'capture_lead') {
    toolCalls.push({
      toolName: 'capture_lead',
      toolInput: { source: input.source, sourceInteractionId: input.sourceInteractionId ?? null },
      permission: { module: 'leads_crm', action: 'create' },
      apply: async () => {
        if (!store.captureLead) throw new Error('this store cannot capture a lead');
        const { id } = await store.captureLead(principal, {
          workspaceId: input.workspaceId,
          source: input.source,
          name: input.name ?? null,
          contact: input.contact ?? null,
          notes: input.notes ?? null,
          sourceInteractionId: input.sourceInteractionId ?? null,
        });
        return { leadId: id };
      },
    });
    output = { drafted: true };
  } else if (input.task === 'capture_lead_from_interaction') {
    toolCalls.push({
      toolName: 'capture_lead',
      toolInput: { source: 'social_dm', interactionId: input.interactionId },
      permission: { module: 'leads_crm', action: 'create' },
      apply: async () => {
        if (!store.captureLeadFromInteraction) throw new Error('this store cannot capture a lead from an interaction');
        const { id, created } = await store.captureLeadFromInteraction(principal, {
          workspaceId: input.workspaceId,
          interactionId: input.interactionId,
          extractedContact: input.extractedContact,
          confidence: input.confidence,
        });
        return { leadId: id, created };
      },
    });
    output = { fromInteraction: input.interactionId };
  } else if (input.task === 'qualify_lead') {
    toolCalls.push({
      toolName: 'qualify_lead',
      toolInput: { leadId: input.leadId, status: input.status },
      permission: { module: 'leads_crm', action: 'edit' },
      apply: async () => {
        if (!store.qualifyLead) throw new Error('this store cannot qualify a lead');
        await store.qualifyLead(principal, { workspaceId: input.workspaceId, leadId: input.leadId, status: input.status });
        return { leadId: input.leadId, status: input.status };
      },
    });
  } else if (input.task === 'draft_follow_up') {
    const body = draftFollowUpBody(input.context);
    toolCalls.push({
      toolName: 'draft_follow_up',
      toolInput: { leadId: input.leadId },
      permission: { module: 'leads_crm', action: 'create' },
      apply: async () => {
        if (!store.draftFollowUp) throw new Error('this store cannot draft a follow-up');
        const { id } = await store.draftFollowUp(principal, { workspaceId: input.workspaceId, leadId: input.leadId, body });
        return { activityId: id };
      },
    });
    output = { draftedBody: body };
  }

  return { output, toolCalls, handoffs };
}
