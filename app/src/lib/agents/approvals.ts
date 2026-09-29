/**
 * Phase F.1 - the general approval-resolution and resume-execution mechanism.
 *
 * runAgent() (orchestrator.ts) already creates an `approval_requests` row whenever decide()
 * returns 'needs_approval', but nothing resolved it before this file - the underlying action
 * just stopped, a real gap documented since Sub-phase E. This is the other half.
 *
 * Resumption is deliberately a small, explicit registry (RESUME_HANDLERS), not a generic
 * "replay the whole agent run" mechanism: an agent's `apply()` closures capture live
 * references (the store, the principal, the original input) at proposal time and cannot be
 * serialized or replayed later. Re-running the ENTIRE original task would also risk redoing
 * steps that already succeeded and persisted (e.g. draft_campaign's own create, which happens
 * before a later budget change ever needs approval). So resuming means calling the exact same
 * AgentStore method the original `apply()` would have called, with the `toolInput` that was
 * captured into the approval request's own `details` at creation time - nothing more.
 *
 * A tool with no registered handler - which today includes every tool that has no `apply()` at
 * all (launch_campaign, propose_domain_connection) - can still be approved for real (the
 * decision itself is genuine and audited), but nothing executes: that is the exact same
 * "structurally cannot do anything" guarantee those tools already have at proposal time,
 * extended to their approval path. Adding a live integration later means adding its resume
 * handler here, in one place, never scattering resume logic across each agent's own file.
 */

import type { AgentStore, Principal } from './types';

export type ApprovalDecision = 'approved' | 'rejected';

export type ResolveApprovalOutcome =
  | { ok: true; status: ApprovalDecision; applied: boolean; result?: Record<string, unknown>; note?: string }
  | { ok: false; reason: string };

type ResumeHandler = (
  store: AgentStore,
  principal: Principal,
  workspaceId: string,
  toolInput: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * One entry per tool that (a) can reach `needs_approval` and (b) has a real `apply()` today.
 * paid_ads's update_campaign_budget is the only tool in the codebase that currently meets
 * both - every other sensitive tool either has no apply() yet (launch_campaign,
 * propose_domain_connection) or is never sensitive in the first place.
 */
const RESUME_HANDLERS: Record<string, ResumeHandler> = {
  update_campaign_budget: async (store, principal, workspaceId, toolInput) => {
    if (!store.updateCampaignBudget) throw new Error('this store cannot update a campaign budget');
    const campaignId = typeof toolInput.campaignId === 'string' ? toolInput.campaignId : '';
    const budgetAmount = Number(toolInput.budgetAmount);
    const budgetPeriod = toolInput.budgetPeriod === 'lifetime' ? 'lifetime' : 'daily';
    if (!campaignId || !Number.isFinite(budgetAmount)) {
      throw new Error('the stored approval details are missing a valid campaignId or budgetAmount');
    }
    await store.updateCampaignBudget(principal, { workspaceId, campaignId, budgetAmount, budgetPeriod });
    return { campaignId, budgetAmount, budgetPeriod };
  },
};

/**
 * Decides a pending approval request. `principal` must be an Admin - the same rule the
 * database's own `private.trg_approval_before()` trigger enforces independently (see
 * 20260928000200_security_functions_and_rls.sql), so a real deployment stays protected even if
 * this check were ever bypassed. Rejecting never executes anything. Approving executes the ONE
 * originally-proposed tool call, if (and only if) a resume handler is registered for it.
 */
export async function resolveApproval(
  store: AgentStore,
  principal: Principal,
  workspaceId: string,
  approvalId: string,
  decision: ApprovalDecision,
  note?: string,
): Promise<ResolveApprovalOutcome> {
  if (principal.role !== 'admin') {
    return { ok: false, reason: 'only an Admin can approve or reject a request' };
  }
  if (!store.getApprovalRequest || !store.decideApprovalRequest) {
    return { ok: false, reason: 'this store cannot resolve approval requests' };
  }

  const record = await store.getApprovalRequest(workspaceId, approvalId);
  if (!record) return { ok: false, reason: 'no such approval request' };
  if (record.status !== 'pending') return { ok: false, reason: `this request has already been ${record.status}` };

  await store.decideApprovalRequest(approvalId, principal.id, decision, note);

  if (decision === 'rejected') {
    return { ok: true, status: 'rejected', applied: false, note };
  }

  const toolName = typeof record.details.toolName === 'string' ? record.details.toolName : null;
  const toolInput = (record.details.toolInput as Record<string, unknown> | undefined) ?? {};
  const handler = toolName ? RESUME_HANDLERS[toolName] : undefined;
  if (!handler) {
    return { ok: true, status: 'approved', applied: false, note };
  }

  try {
    const result = await handler(store, principal, record.workspaceId, toolInput);
    return { ok: true, status: 'approved', applied: true, result, note };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the approved action could not be carried out' };
  }
}
