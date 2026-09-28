import type { Action } from '@/lib/permissions';
import type { PostStatus } from './types';

/**
 * The life of a post, and who may move it. The database enforces exactly the same table
 * (private.social_required_actions in migration 0500); tests/db/social.test.ts compares them
 * for every pair of statuses.
 *
 * A move needs ONE of the listed permissions on the Social module, or is "server": only the
 * server (the publishing worker) may make it, never a person using the app.
 *
 * Note that scheduling and publishing use `publish_execute`, which is on the sensitive list:
 * for everyone except an Admin it turns into an approval request, so in practice only an Admin
 * can schedule or publish. A Client can at most write and approve, and only if an Admin allowed it.
 */
export type Requirement = readonly Action[] | 'server';

export const TRANSITIONS: Record<PostStatus, Partial<Record<PostStatus, Requirement>>> = {
  draft: { in_review: ['create', 'edit'], cancelled: ['edit'] },
  in_review: { draft: ['approve', 'edit'], approved: ['approve'], cancelled: ['edit'] },
  approved: { draft: ['edit'], scheduled: ['publish_execute'], publishing: ['publish_execute'], cancelled: ['edit'] },
  scheduled: { approved: ['publish_execute'], publishing: 'server', cancelled: ['publish_execute'] },
  publishing: { published: 'server', failed: 'server' },
  failed: { approved: ['publish_execute'], draft: ['edit'], cancelled: ['edit'] },
  published: {},
  cancelled: {},
};

export function requirementFor(from: PostStatus, to: PostStatus): Requirement | null {
  return TRANSITIONS[from][to] ?? null;
}

export const canTransition = (from: PostStatus, to: PostStatus) => requirementFor(from, to) !== null;

/** Statuses in which a post's words can still be edited (an edit sends it back to Draft). */
export const EDITABLE: readonly PostStatus[] = ['draft', 'in_review', 'approved', 'scheduled', 'failed'];

export const isFinal = (status: PostStatus) => status === 'published' || status === 'cancelled';
