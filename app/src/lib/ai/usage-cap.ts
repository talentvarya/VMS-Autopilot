/**
 * Phase F.2 - the AI usage hard-cap pre-check, and the usage/blocked-event recorders.
 *
 * Phase F.1 already built a database trigger that refuses an ai_usage_log insert once a
 * workspace's daily-call or monthly-cost cap is met - but that fires AFTER a call already
 * happened, so it can only stop the LOG from landing, not stop the money being spent. This
 * module is the layer that actually prevents the spend: checkAiUsageCap() reads current
 * totals and decides allow/block BEFORE any real AI provider is ever called. The Phase F.1
 * trigger remains as a second, independent backstop against a bug here or a race between two
 * concurrent calls - a rejection there is a safe, expected outcome, not a bug.
 *
 * Fail-loud, by design: a blocked call throws (see AiUsageCapExceededError) rather than
 * silently falling back to anything, is never retried automatically, and the caller is
 * expected to record the blocked attempt via recordAiCapBlockedEvent() (an audit_log entry -
 * the database never sees a call that was refused before it happened, so the application
 * records it itself, the same rule src/lib/permissions/audit.ts already documents for denied
 * permission attempts).
 */

import type { AuditEvent } from '@/lib/permissions';
import type { AgentStore, AiUsageCapStatus, Principal, RecordAiUsageInput } from '../agents/types';

export type { AiUsageCapStatus, RecordAiUsageInput } from '../agents/types';

export type AiUsageCapEvaluation = { allowed: true } | { allowed: false; reason: string };

/** Pure - no I/O, so it is trivially unit-testable with fixture numbers. */
export function evaluateAiUsageCap(status: AiUsageCapStatus): AiUsageCapEvaluation {
  if (status.dailyCallCap !== null && status.dailyCallCount >= status.dailyCallCap) {
    return { allowed: false, reason: `the daily AI usage cap (${status.dailyCallCap} calls) has already been reached for this workspace` };
  }
  if (status.monthlyCostCapUsd !== null && status.monthlyCostUsd >= status.monthlyCostCapUsd) {
    return { allowed: false, reason: `the monthly AI cost cap ($${status.monthlyCostCapUsd}) has already been reached for this workspace` };
  }
  return { allowed: true };
}

export class AiUsageCapExceededError extends Error {
  constructor(reason: string) {
    super(`AI usage cap reached: ${reason}. No AI call was made, and this is not retried automatically.`);
    this.name = 'AiUsageCapExceededError';
  }
}

/**
 * Throws AiUsageCapExceededError if the workspace is already at or over either cap. A store
 * with no getAiUsageCapStatus() implemented is treated as having no caps configured (never
 * blocks) - only a real Postgres-backed store can enforce this pre-check for real, and Phase
 * F.1's own database trigger is the backstop either way.
 */
export async function checkAiUsageCap(store: AgentStore, workspaceId: string): Promise<void> {
  if (!store.getAiUsageCapStatus) return;
  const status = await store.getAiUsageCapStatus(workspaceId);
  const evaluation = evaluateAiUsageCap(status);
  if (!evaluation.allowed) throw new AiUsageCapExceededError(evaluation.reason);
}

/**
 * A small, explicit per-model USD-per-million-token pricing table - update this when
 * Anthropic's published pricing changes; it is the one place that knows it. These numbers are
 * a placeholder to be verified against Anthropic's current published pricing before this
 * capability is ever turned on for real - the same caveat docs/BUFFER-GO-LIVE-DESIGN.md
 * already states about any third-party provider's numbers changing over time.
 */
const PRICING_USD_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5': { input: 3, output: 15 },
};
const DEFAULT_PRICING = { input: 3, output: 15 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING_USD_PER_MILLION_TOKENS[model] ?? DEFAULT_PRICING;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/** Logs a REAL, successful call. A no-op if the store cannot record usage. */
export async function recordAiUsage(store: AgentStore, input: RecordAiUsageInput): Promise<void> {
  await store.recordAiUsage?.(input);
}

/**
 * Records a blocked attempt (cap already exceeded, so no AI provider was ever called) as an
 * audit_log entry - never in ai_usage_log, which is reserved for calls that actually happened
 * and actually have real token counts. A no-op if the store cannot record audit events.
 */
export async function recordAiCapBlockedEvent(
  store: AgentStore,
  principal: Principal,
  workspaceId: string,
  reason: string,
): Promise<void> {
  const event: AuditEvent = {
    actorId: principal.id,
    actorRole: principal.role,
    workspaceId,
    module: 'social',
    action: 'ai.caption_blocked',
    result: 'denied',
    metadata: { reason },
  };
  await store.recordAuditEvent?.(event);
}
