/**
 * The AI Orchestrator - the only thing that ever invokes an agent or decides what an agent's
 * proposed action is allowed to do. See docs/AGENT-RUNTIME-ARCHITECTURE.md for the full design.
 * Sub-phase A wired one agent (sandbox_echo, proposal-only); Sub-phase B adds a second
 * (social_media_super_agent) whose allowed tool calls actually persist something real.
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
 *      (see social/agent.ts) - never a shortcut built for agents.
 */

import { decide } from '@/lib/permissions';
import { runEchoAgent, type EchoAgentInput } from './echo-agent';
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
  handoffs: Handoff[];
}

export type RunOutcome = { ok: true; run: RunRecord } | { ok: false; reason: string };

/** The only entry point. Runs one agent once, start to finish. */
export async function runAgent(store: AgentStore, principal: Principal, request: RunRequest): Promise<RunOutcome> {
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
    },
  };
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
 * Sub-phase A shipped one agent's logic; Sub-phase B adds a second. A later sub-phase adds
 * more cases here (and eventually a real AI call for agents other than these scripted ones) -
 * never a change to runAgent()'s own permission-checking logic above.
 */
async function invokeAgentLogic(
  agentKey: string,
  input: Record<string, unknown>,
  store: AgentStore,
  principal: Principal,
): Promise<AgentLogicResult> {
  if (agentKey === 'sandbox_echo') return runEchoAgent(input as unknown as EchoAgentInput);
  if (agentKey === 'social_media_super_agent') return runSocialMediaSuperAgent(input as unknown as SocialAgentInput, store, principal);
  throw new Error(`no logic implemented yet for agent "${agentKey}"`);
}
