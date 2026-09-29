import type { Action } from '@/lib/permissions';
import { sha256Hex } from '@/lib/social/hash';
import type { ContentDraftStatus } from './types';

/**
 * The life of a content draft, and who may move it. The database enforces the EXACT SAME
 * table (private.content_draft_required_actions in migration 20260929000300); a test compares
 * them. Mirrors the SHAPE of agents/social/state.ts's reply life: no "published" state exists
 * here either - nothing in this project can publish to a real website yet.
 */
export type Requirement = readonly Action[];

export const CONTENT_DRAFT_TRANSITIONS: Record<ContentDraftStatus, Partial<Record<ContentDraftStatus, Requirement>>> = {
  draft: { in_review: ['create', 'edit'], cancelled: ['edit'] },
  in_review: { draft: ['approve', 'edit'], approved: ['approve'], cancelled: ['edit'] },
  approved: { draft: ['edit'], cancelled: ['edit'] },
  cancelled: {},
};

export function contentDraftRequirementFor(from: ContentDraftStatus, to: ContentDraftStatus): Requirement | null {
  return CONTENT_DRAFT_TRANSITIONS[from][to] ?? null;
}

export const contentDraftCanTransition = (from: ContentDraftStatus, to: ContentDraftStatus) => contentDraftRequirementFor(from, to) !== null;

export const CONTENT_DRAFT_EDITABLE: readonly ContentDraftStatus[] = ['draft', 'in_review', 'approved'];

/**
 * Fingerprint of exactly what was approved. Must match private.content_draft_hash() in
 * supabase/migrations/20260929000300_content_agent.sql (a test compares them).
 */
export function contentDraftHash(title: string, body: string): string {
  return sha256Hex(`${title}\n${body}`);
}
