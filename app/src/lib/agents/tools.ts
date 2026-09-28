/**
 * The tool registry. A tool is the ONLY way an agent can ever propose to do anything - this
 * list, not prompt wording, is the real security boundary (see
 * docs/AGENT-RUNTIME-ARCHITECTURE.md, safety rule 5). An agent may only call a tool that is
 * both defined here AND listed in its own agent_definitions.allowed_tools.
 */

import type { Action, Module } from '@/lib/permissions';

export interface ToolDefinition {
  name: string;
  description: string;
  /** Present when calling this tool proposes an action the permission system must decide. */
  permission?: { module: Module; action: Action };
}

/**
 * Sub-phase A ships exactly three tools, all for the sandbox_echo demo agent, deliberately
 * mapped to EXISTING permission pairs from src/lib/permissions/policy.ts rather than
 * inventing a new one:
 *  - echo_message: pure utility, no permission attached, always allowed - proves the plumbing
 *    with zero risk.
 *  - propose_demo_action -> ai_assistant:publish_execute ("the AI executing a command").
 *    This pair is CEILING-blocked for everyone but Admin - no grant can ever unlock it (the
 *    PRD's "Client AI is read-only" rule). Proves an agent is refused outright, not merely
 *    sent for approval, when the action is one nobody but Admin may ever hold.
 *  - propose_grantable_demo_action -> paid_ads:publish_execute. An Admin can grant this to a
 *    Client or Team member, but because it is sensitive it always still needs an Admin's
 *    approval. Proves the "granted but still needs approval" path end to end.
 */
export const TOOLS: Record<string, ToolDefinition> = {
  echo_message: {
    name: 'echo_message',
    description: 'Repeats back the text it was given. No permission check.',
  },
  propose_demo_action: {
    name: 'propose_demo_action',
    description: 'A harmless stand-in for "the AI wants to execute something." Ceiling-blocked for everyone but Admin - no grant can ever unlock it.',
    permission: { module: 'ai_assistant', action: 'publish_execute' },
  },
  propose_grantable_demo_action: {
    name: 'propose_grantable_demo_action',
    description: "A harmless stand-in for a normally-grantable sensitive action (like a budget change). Even when granted, it still always needs an Admin's approval.",
    permission: { module: 'paid_ads', action: 'publish_execute' },
  },
};

export function toolDefinition(name: string): ToolDefinition | undefined {
  return TOOLS[name];
}
