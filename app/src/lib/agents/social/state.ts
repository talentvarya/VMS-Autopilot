import type { Action } from '@/lib/permissions';
import { sha256Hex } from '@/lib/social/hash';
import type { ReplyStatus } from './types';

/**
 * The life of a reply draft, and who may move it. The database enforces the EXACT SAME table
 * (private.social_reply_required_actions in migration 20260929000200); a test compares them.
 * This mirrors the SHAPE of src/lib/social/state.ts, deliberately kept shorter: there is no
 * scheduling or publishing/sending state for a reply yet (Sub-phase B never sends anything).
 */
export type Requirement = readonly Action[];

export const REPLY_TRANSITIONS: Record<ReplyStatus, Partial<Record<ReplyStatus, Requirement>>> = {
  drafted: { in_review: ['create', 'edit'], cancelled: ['edit'] },
  in_review: { drafted: ['approve', 'edit'], approved: ['approve'], cancelled: ['edit'] },
  approved: { drafted: ['edit'], cancelled: ['edit'] },
  cancelled: {},
};

export function replyRequirementFor(from: ReplyStatus, to: ReplyStatus): Requirement | null {
  return REPLY_TRANSITIONS[from][to] ?? null;
}

export const replyCanTransition = (from: ReplyStatus, to: ReplyStatus) => replyRequirementFor(from, to) !== null;

/** Statuses in which a reply's words can still be edited (an edit sends it back to Drafted). */
export const REPLY_EDITABLE: readonly ReplyStatus[] = ['drafted', 'in_review', 'approved'];

/**
 * Fingerprint of exactly what was approved. Must match private.social_reply_hash() in
 * supabase/migrations/20260929000200_social_super_agent.sql (a test compares them).
 */
export function replyContentHash(interactionId: string, body: string): string {
  return sha256Hex(`${interactionId}\n${body}`);
}
