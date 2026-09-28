/**
 * The AI Orchestrator - the only thing that ever invokes an agent or decides what an agent's
 * proposed action is allowed to do. See docs/AGENT-RUNTIME-ARCHITECTURE.md for the full design;
 * this file is the Sub-phase A skeleton, wired to exactly one agent (sandbox_echo).
 *
 * For every proposed tool call, in this order:
 *   1. If the tool is not on the agent's own allowed_tools list, refuse it. This list - not
 *      prompt wording - is the real security boundary.
 *   2. If the tool maps to a permission, run decide() - the EXACT SAME function a human's own
 *      click already goes through - using the role/grants of the person this run is acting on
 *      behalf of. An agent can never be treated as more permitted than that person.
 *   3. Never apply the proposed action itself. Sub-phase A's only agent has no real action to
 *      apply anyway; a later agent's actual writes go through the same functions a human's own
 *      click already uses (createDraft(), transition(), ...), never a shortcut built for agents.
 */

import { decide, type Grant, type Role } from '@/lib/permissions';
import { runEchoAgent, type EchoAgentInput } from './echo-agent';
import { toolDefinition } from './tools';
import type {
  AgentDefinition,
  AgentLogicResult,
  Handoff,
  ResolvedToolCall,
  RunStatus,
} from './types';

export interface Principal {
  id: string;
  role: Role;
  grants: readonly Grant[];
}

export interface RunRequest {
  workspaceId: string;
  agentKey: string;
  triggeredByKind: 'user' | 'system' | 'agent';
  input: Record<string, unknown>;
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
  handoffs: Handoff[];
}

export interface ApprovalRequestInput {
  workspaceId: string;
  requestedBy: string;
  module: string;
  action: string;
  title: string;
  details: Record<string, unknown>;
}

/**
 * What the Orchestrator needs from the outside world. Sub-phase A tests it against a small
 * in-memory fake; a real Supabase service-role client is a drop-in replacement later without
 * changing runAgent()'s own logic.
 */
export interface AgentStore {
  findDefinition(workspaceId: string, agentKey: string): Promise<AgentDefinition | null>;
  newId(): string;
  createApprovalRequest(input: ApprovalRequestInput): Promise<{ id: string }>;
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

  const logic = await invokeAgentLogic(request.agentKey, request.input);

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
      resolved.push({ ...call, toolOutput: { ok: true }, decision: null, onBehalfOf: null });
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
    resolved.push({
      ...call,
      toolOutput: decision.effect === 'allow' ? { ok: true } : null,
      decision: decision.effect,
      onBehalfOf: principal.id,
      approvalId,
    });
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
      errorMessage: anyDenied ? 'one or more proposed actions were refused by the permission rules' : null,
      toolCalls: resolved,
      handoffs: logic.handoffs,
    },
  };
}

/**
 * Sub-phase A has exactly one agent's logic. A later sub-phase adds a real dispatch table
 * here (and eventually a real AI call for agents other than the sandbox one) - never a change
 * to runAgent()'s own permission-checking logic above.
 */
async function invokeAgentLogic(agentKey: string, input: Record<string, unknown>): Promise<AgentLogicResult> {
  if (agentKey === 'sandbox_echo') return runEchoAgent(input as unknown as EchoAgentInput);
  throw new Error(`no logic implemented yet for agent "${agentKey}"`);
}
