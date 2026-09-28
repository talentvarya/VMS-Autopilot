/**
 * The sandbox echo agent - a scripted, deterministic stand-in for a real AI agent. It makes no
 * network call and calls no AI provider; given the same input it always produces the same
 * output. Its only purpose is to prove the Orchestrator's routing, permission checks, approval
 * flow, audit trail and tenant isolation actually work before any real agent exists.
 */

import type { AgentLogicResult } from './types';

export interface EchoAgentInput {
  message: string;
  /** When true, also proposes the ceiling-blocked demo action (see tools.ts). */
  proposeDemoAction?: boolean;
  /** When true, also proposes the grantable-but-sensitive demo action (see tools.ts). */
  proposeGrantableDemoAction?: boolean;
  /** When true, also tries a tool that does not exist - proves the "unknown tool" refusal path. */
  proposeUnknownTool?: boolean;
  /** When set, also emits a handoff to this agent key (proves the handoff table, nothing more). */
  handoffTo?: string;
}

export function runEchoAgent(input: EchoAgentInput): AgentLogicResult {
  const toolCalls: AgentLogicResult['toolCalls'] = [
    { toolName: 'echo_message', toolInput: { message: input.message } },
  ];
  if (input.proposeDemoAction) {
    toolCalls.push({
      toolName: 'propose_demo_action',
      toolInput: { note: input.message },
      permission: { module: 'ai_assistant', action: 'publish_execute' },
    });
  }
  if (input.proposeGrantableDemoAction) {
    toolCalls.push({
      toolName: 'propose_grantable_demo_action',
      toolInput: { note: input.message },
      permission: { module: 'paid_ads', action: 'publish_execute' },
    });
  }
  if (input.proposeUnknownTool) {
    toolCalls.push({ toolName: 'delete_everything', toolInput: {} });
  }
  const handoffs: AgentLogicResult['handoffs'] = input.handoffTo
    ? [{ toAgentKey: input.handoffTo, payload: { fromMessage: input.message } }]
    : [];
  return { output: { echoed: input.message }, toolCalls, handoffs };
}
