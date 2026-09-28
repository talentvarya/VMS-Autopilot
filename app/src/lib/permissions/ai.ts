/**
 * AI assistant mode. Non-negotiable rule from the PRD (section 8): Client AI is
 * read-only. It may explain reports and status but can never execute commands, change
 * content, publish, change budgets, alter domains or modify integrations.
 *
 * This is enforced twice: here (so the AI layer refuses before doing anything) and by the
 * role ceiling on the `ai_assistant` module (so even a hand-edited grant cannot give a
 * non-admin more than `view`).
 */

import type { Role } from './types';

export type AiMode = 'none' | 'read_only' | 'full';

export function aiModeFor(role: Role | null): AiMode {
  if (role === 'admin') return 'full';
  if (role === 'client' || role === 'team_member') return 'read_only';
  return 'none';
}

/** True only for Admin. Every AI tool call that changes anything must check this first. */
export function canAiExecute(role: Role | null): boolean {
  return aiModeFor(role) === 'full';
}
