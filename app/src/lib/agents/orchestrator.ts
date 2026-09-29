/**
 * The AI Orchestrator - the only thing that ever invokes an agent or decides what an agent's
 * proposed action is allowed to do. See docs/AGENT-RUNTIME-ARCHITECTURE.md for the full design.
 * Sub-phase A wired one agent (sandbox_echo, proposal-only); Sub-phase B added a second
 * (social_media_super_agent) whose allowed tool calls actually persist something real;
 * Sub-phase C adds two more (seo_geo_agent, content_agent) and, for the first time, lets the
 * Orchestrator automatically resolve a handoff whose target agent actually exists.
 *
 * For every proposed tool call, in this order:
 *   1. If the tool is not on the agent's own allowed_tools list, refuse it. This list - not
 *      prompt wording - is the real security boundary.
 *   2. If the tool maps to a permission, run decide() - the EXACT SAME function a human's own
 *      click already goes through - using the role/grants of the person this run is acting on
 *      behalf of. An agent can never be treated as more permitted than that person.
 *   3. Only once a call is allowed (or needed no permission at all) does its own `apply()` run,
 *      if it has one. Sub-phase A's tools never define one, so their behaviour is unchanged.
 *      A tool WITH one still goes through the same functions a human's own click already uses
 *      (see social/agent.ts, seo/agent.ts, content/agent.ts) - never a shortcut built for agents.
 *
 * For every handoff an agent proposes: the Orchestrator tries to run the target agent itself,
 * using the SAME principal (so the whole chain stays bound by the same person's own role and
 * grants, exactly as if they had triggered every step by hand) and `triggeredByKind: 'agent'`.
 * If no enabled agent exists for that key in this workspace - which is exactly the case for
 * 'analytics_reporting_agent' and 'lead_crm_agent' today - the handoff is recorded as
 * unresolved, not treated as an error. A small depth limit stops a misconfigured pair of
 * agents from handing off to each other forever.
 */

import { decide } from '@/lib/permissions';
import { runContentAgent, type ContentAgentInput } from './content/agent';
import { runEchoAgent, type EchoAgentInput } from './echo-agent';
import { runSeoGeoAgent, type SeoGeoAgentInput } from './seo/agent';
import { runSocialMediaSuperAgent, type SocialAgentInput } from './social/agent';
import { toolDefinition } from './tools';
import type {
  AgentLogicResult,
  AgentStore,
  Handoff,
  Principal,
  ProposedToolCall,
  ResolvedToolCall,
  RunRequest,
  RunStatus,
} from './types';

export type { AgentStore, ApprovalRequestInput, Principal, RunRequest } from './types';

/** The Orchestrator's own decision about one proposed handoff - not what the agent proposed. */
export interface ResolvedHandoff extends Handoff {
  resolved: boolean;
  /** Present only when resolved: false - why it was left for later. */
  reason?: string;
  /** Present only when resolved: true. */
  run?: RunRecord;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  agentDefinitionId: string | null;
  agentKey: string;
  triggeredBy: string | null;
  triggeredByKind: RunRequest['triggeredByKind'];
  status: RunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  errorMessage: string | null;
  toolCalls: ResolvedToolCall[];
  /** Exactly what the agent proposed - unchanged shape from Sub-phases A/B. */
  handoffs: Handoff[];
  /** What the Orchestrator actually did about each of those handoffs, in the same order. */
  resolvedHandoffs: ResolvedHandoff[];
}

export type RunOutcome = { ok: true; run: RunRecord } | { ok: false; reason: string };

const MAX_HANDOFF_DEPTH = 5;

/** The only entry point. Runs one agent once, start to finish, then resolves its handoffs. */
export async function runAgent(store: AgentStore, principal: Principal, request: RunRequest, depth = 0): Promise<RunOutcome> {
  const definition = await store.findDefinition(request.workspaceId, request.agentKey);
  if (!definition) {
    return { ok: false, reason: `no agent named "${request.agentKey}" is configured for this workspace` };
  }
  if (!definition.enabled) {
    return { ok: false, reason: `the "${definition.displayName}" agent is switched off for this workspace` };
  }

  const logic = await invokeAgentLogic(request.agentKey, request.input, store, principal);

  const resolved: ResolvedToolCall[] = [];
  let anyDenied = false;
  let anyNeedsApproval = false;

  for (const call of logic.toolCalls) {
    const known = toolDefinition(call.toolName);
    if (!known || !definition.allowedTools.includes(call.toolName)) {
      anyDenied = true;
      resolved.push({ ...call, toolOutput: null, decision: 'deny', onBehalfOf: null });
      continue;
    }
    if (!call.permission) {
      const resolvedCall = await applyIfAllowed(call, true);
      if (resolvedCall.applyError) anyDenied = true;
      resolved.push(resolvedCall);
      continue;
    }

    const decision = decide({ role: principal.role, grants: principal.grants }, call.permission.module, call.permission.action);
    let approvalId: string | null = null;
    if (decision.effect === 'deny') anyDenied = true;
    if (decision.effect === 'needs_approval') {
      anyNeedsApproval = true;
      const approval = await store.createApprovalRequest({
        workspaceId: request.workspaceId,
        requestedBy: principal.id,
        module: call.permission.module,
        action: call.permission.action,
        title: `${definition.displayName}: ${call.toolName}`,
        details: { toolInput: call.toolInput, agentKey: request.agentKey },
      });
      approvalId = approval.id;
    }
    const resolvedCall = await applyIfAllowed(call, decision.effect === 'allow');
    if (resolvedCall.applyError) anyDenied = true;
    resolved.push({ ...resolvedCall, decision: decision.effect, onBehalfOf: principal.id, approvalId });
  }

  const status: RunStatus = anyDenied ? 'failed' : anyNeedsApproval ? 'needs_approval' : 'succeeded';
  const resolvedHandoffs = await resolveHandoffs(store, principal, request.workspaceId, logic.handoffs, depth);

  return {
    ok: true,
    run: {
      id: store.newId(),
      workspaceId: request.workspaceId,
      agentDefinitionId: definition.id,
      agentKey: request.agentKey,
      triggeredBy: request.triggeredByKind === 'user' ? principal.id : null,
      triggeredByKind: request.triggeredByKind,
      status,
      input: request.input,
      output: logic.output,
      errorMessage: anyDenied ? 'one or more proposed actions were refused, or failed, while being carried out' : null,
      toolCalls: resolved,
      handoffs: logic.handoffs,
      resolvedHandoffs,
    },
  };
}

/**
 * Tries to run the target agent for each proposed handoff, using the SAME principal. A
 * handoff whose target agent has no enabled definition in this workspace - or whose logic
 * simply doesn't exist yet - is left unresolved rather than treated as a failure: that is
 * exactly the expected, documented state for 'analytics_reporting_agent' and 'lead_crm_agent'
 * today. The depth limit exists only to stop a future misconfiguration (two agents handing
 * off to each other) from recursing forever; it is not expected to ever be hit in practice.
 */
async function resolveHandoffs(
  store: AgentStore,
  principal: Principal,
  workspaceId: string,
  handoffs: Handoff[],
  depth: number,
): Promise<ResolvedHandoff[]> {
  const results: ResolvedHandoff[] = [];
  for (const handoff of handoffs) {
    if (depth >= MAX_HANDOFF_DEPTH) {
      results.push({ ...handoff, resolved: false, reason: 'handoff depth limit reached' });
      continue;
    }
    try {
      const outcome = await runAgent(
        store,
        principal,
        { workspaceId, agentKey: handoff.toAgentKey, triggeredByKind: 'agent', input: handoff.payload },
        depth + 1,
      );
      results.push(outcome.ok ? { ...handoff, resolved: true, run: outcome.run } : { ...handoff, resolved: false, reason: outcome.reason });
    } catch (error) {
      results.push({ ...handoff, resolved: false, reason: error instanceof Error ? error.message : 'the handoff could not be resolved' });
    }
  }
  return results;
}

/**
 * Runs `call.apply()` when the call is allowed and has one, and shapes the result exactly as
 * Sub-phase A's own placeholder outputs did for every call with no `apply()` - so a tool
 * without one behaves identically to before this function existed.
 */
async function applyIfAllowed(call: ProposedToolCall, allowed: boolean): Promise<ResolvedToolCall> {
  if (!allowed) return { ...call, toolOutput: null, decision: null, onBehalfOf: null };
  if (!call.apply) return { ...call, toolOutput: { ok: true }, decision: null, onBehalfOf: null };
  try {
    const toolOutput = await call.apply();
    return { ...call, toolOutput, decision: null, onBehalfOf: null };
  } catch (error) {
    return {
      ...call,
      toolOutput: null,
      decision: null,
      onBehalfOf: null,
      applyError: error instanceof Error ? error.message : 'the action could not be carried out',
    };
  }
}

/**
 * Sub-phase A shipped one agent's logic; Sub-phases B and C add more. A later sub-phase adds
 * more cases here (and eventually a real AI call for agents other than these scripted ones) -
 * never a change to runAgent()'s own permission-checking or handoff-resolution logic above.
 */
async function invokeAgentLogic(
  agentKey: string,
  input: Record<string, unknown>,
  store: AgentStore,
  principal: Principal,
): Promise<AgentLogicResult> {
  if (agentKey === 'sandbox_echo') return runEchoAgent(input as unknown as EchoAgentInput);
  if (agentKey === 'social_media_super_agent') return runSocialMediaSuperAgent(input as unknown as SocialAgentInput, store, principal);
  if (agentKey === 'seo_geo_agent') return runSeoGeoAgent(input as unknown as SeoGeoAgentInput, store, principal);
  if (agentKey === 'content_agent') return runContentAgent(input as unknown as ContentAgentInput, store, principal);
  throw new Error(`no logic implemented yet for agent "${agentKey}"`);
}
