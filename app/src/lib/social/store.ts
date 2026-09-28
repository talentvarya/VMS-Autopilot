import { decide, type Action, type Grant, type Role } from '@/lib/permissions';
import { NETWORK_LIMITS, charLength } from './networks';
import { contentHash } from './hash';
import type { SocialProvider } from './provider';
import { EDITABLE, requirementFor } from './state';
import { LIMITS, POST_STATUS_LABELS, type Channel, type Plan, type PostStatus, type SocialPost } from './types';
import { hasErrors, validatePost } from './validate';

/**
 * The social publishing rules, applied in memory. The Social page uses this so people can try
 * the whole flow with sample data, and the tests hold it side by side with the database rules
 * (supabase/migrations/20260928000500_social.sql), which enforce the same things for real.
 *
 * Every method takes the ACTOR (who is doing it) and checks their permission with the same
 * decide() function the rest of the app uses. Nothing here contacts anything.
 */

export interface Actor {
  id: string;
  role: Role;
  grants: readonly Grant[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const fail = (code: string, message: string): Result<never> => ({ ok: false, code, message });
const ok = <T,>(value: T): Result<T> => ({ ok: true, value });

const day = (iso: string) => iso.slice(0, 10);

export interface StoreOptions {
  now: () => Date;
  channels: Channel[];
  plan: Plan;
  posts?: SocialPost[];
  newId?: () => string;
}

export class SocialStore {
  readonly plan: Plan;
  private readonly now: () => Date;
  private readonly newId: () => string;
  channels: Channel[];
  posts: SocialPost[];

  constructor(options: StoreOptions) {
    this.now = options.now;
    this.plan = options.plan;
    this.channels = options.channels.map((c) => ({ ...c }));
    this.posts = (options.posts ?? []).map((p) => ({ ...p }));
    let n = 0;
    this.newId = options.newId ?? (() => `post-${++n}`);
  }

  // -- helpers ---------------------------------------------------------------------------
  channel(id: string) {
    return this.channels.find((c) => c.id === id);
  }
  post(id: string) {
    return this.posts.find((p) => p.id === id);
  }
  private allowed(actor: Actor, action: Action) {
    return decide({ role: actor.role, grants: actor.grants }, 'social', action).effect === 'allow';
  }
  private permission(actor: Actor, actions: readonly Action[]): Result<true> {
    if (actions.some((a) => this.allowed(actor, a))) return ok(true);
    const needsApproval = actions.some((a) => decide({ role: actor.role, grants: actor.grants }, 'social', a).effect === 'needs_approval');
    return fail(
      needsApproval ? 'needs_admin' : 'not_allowed',
      needsApproval ? 'This needs an Admin from your agency. They will do it for you.' : 'You do not have permission to do this. Ask your agency if you need it.',
    );
  }
  private replace(next: SocialPost) {
    this.posts = this.posts.map((p) => (p.id === next.id ? next : p));
    return next;
  }
  private stamp(p: SocialPost): SocialPost {
    return { ...p, updatedAt: this.now().toISOString() };
  }
  private hashOf(p: SocialPost) {
    return contentHash(p.channelId, p.body, p.imageAlt);
  }

  // -- writing ---------------------------------------------------------------------------
  createDraft(actor: Actor, input: { channelId: string; body: string; imageAlt?: string | null; groupId?: string | null }): Result<SocialPost> {
    const allowed = this.permission(actor, ['create']);
    if (!allowed.ok) return allowed;
    const channel = this.channel(input.channelId);
    if (!channel) return fail('no_channel', 'That channel does not exist in this workspace.');
    if (channel.status === 'disconnected' || channel.status === 'expired') return fail('channel_unavailable', 'That channel is not connected, so posts cannot be written for it.');
    if (input.body.trim().length === 0) return fail('body_empty', 'Write something first: the post is empty.');
    if (charLength(input.body) > NETWORK_LIMITS[channel.network].maxChars) return fail('body_too_long', 'The post is longer than this network allows.');
    const today = day(this.now().toISOString());
    if (this.posts.filter((p) => day(p.createdAt) === today).length >= LIMITS.maxNewPostsPerWorkspacePerDay) {
      return fail('daily_limit', `Too many new posts today (limit ${LIMITS.maxNewPostsPerWorkspacePerDay}). Please try again tomorrow.`);
    }
    const iso = this.now().toISOString();
    const post: SocialPost = {
      id: this.newId(), workspaceId: channel.workspaceId, channelId: channel.id, groupId: input.groupId ?? null,
      body: input.body, imageAlt: input.imageAlt || null, status: 'draft', scheduledAt: null,
      createdBy: actor.id, createdAt: iso, updatedAt: iso, approvedBy: null, approvedAt: null, approvedHash: null,
      publishedAt: null, externalPostId: null, lastError: null, attemptCount: 0,
    };
    this.posts = [...this.posts, post];
    return ok(post);
  }

  /** One post per chosen channel, linked as a group. */
  createDrafts(actor: Actor, input: { channelIds: string[]; body: string; imageAlt?: string | null }): Result<SocialPost[]> {
    if (input.channelIds.length === 0) return fail('no_channel', 'Choose at least one channel.');
    const groupId = input.channelIds.length > 1 ? `group-${this.newId()}` : null;
    const made: SocialPost[] = [];
    for (const channelId of input.channelIds) {
      const r = this.createDraft(actor, { channelId, body: input.body, imageAlt: input.imageAlt, groupId });
      if (!r.ok) {
        this.posts = this.posts.filter((p) => !made.some((m) => m.id === p.id)); // all or nothing
        return r;
      }
      made.push(r.value);
    }
    return ok(made);
  }

  /** Changing the words of anything that was already approved sends it back to Draft: it must be approved again. */
  edit(actor: Actor, postId: string, changes: { body?: string; imageAlt?: string | null }): Result<SocialPost> {
    const p = this.post(postId);
    if (!p) return fail('not_found', 'That post does not exist.');
    const allowed = this.permission(actor, ['edit']);
    if (!allowed.ok) return allowed;
    if (!EDITABLE.includes(p.status)) return fail('locked', `A post that is ${POST_STATUS_LABELS[p.status].toLowerCase()} can no longer be edited.`);
    const body = changes.body ?? p.body;
    const imageAlt = changes.imageAlt === undefined ? p.imageAlt : changes.imageAlt || null;
    if (body.trim().length === 0) return fail('body_empty', 'Write something first: the post is empty.');
    const channel = this.channel(p.channelId)!;
    if (charLength(body) > NETWORK_LIMITS[channel.network].maxChars) return fail('body_too_long', 'The post is longer than this network allows.');
    const changed = body !== p.body || imageAlt !== p.imageAlt;
    if (!changed) return ok(p);
    return ok(this.replace(this.stamp({
      ...p, body, imageAlt, status: 'draft', scheduledAt: null, approvedBy: null, approvedAt: null, approvedHash: null, lastError: null,
    })));
  }

  // -- moving a post through its life ------------------------------------------------------
  transition(actor: Actor, postId: string, to: PostStatus, options: { scheduledAt?: string } = {}): Result<SocialPost> {
    const p = this.post(postId);
    if (!p) return fail('not_found', 'That post does not exist.');
    const requirement = requirementFor(p.status, to);
    if (requirement === null) return fail('illegal', `A post that is ${POST_STATUS_LABELS[p.status].toLowerCase()} cannot become ${POST_STATUS_LABELS[to].toLowerCase()}.`);
    if (requirement === 'server') return fail('server_only', 'Only the publishing system can do this.');
    const allowed = this.permission(actor, requirement);
    if (!allowed.ok) return allowed;

    const channel = this.channel(p.channelId)!;
    const now = this.now();
    let next: SocialPost = { ...p, status: to };

    if (to === 'in_review' || to === 'approved' || to === 'scheduled' || to === 'publishing') {
      const issues = validatePost({ network: channel.network, body: p.body, imageAlt: p.imageAlt }, now);
      if (hasErrors(issues)) return fail('invalid', issues.find((i) => i.level === 'error')!.message);
    }
    if (to === 'approved' && p.status === 'in_review') {
      if (actor.role !== 'admin' && p.createdBy === actor.id) {
        return fail('own_post', 'A second person needs to approve this. You cannot approve a post you wrote yourself.');
      }
      next = { ...next, approvedBy: actor.id, approvedAt: now.toISOString(), approvedHash: this.hashOf(p), scheduledAt: null };
    }
    if (to === 'scheduled' || to === 'publishing') {
      if (this.hashOf(p) !== p.approvedHash) return fail('changed_after_approval', 'The text changed after it was approved. It needs to be approved again.');
      if (channel.status !== 'active') return fail('channel_unavailable', channel.status === 'paused' ? 'This channel is paused. Resume it first.' : 'This channel is not connected right now.');
    }
    if (to === 'scheduled') {
      const when = options.scheduledAt;
      if (!when) return fail('schedule_missing', 'Choose a date and time.');
      const issues = validatePost({ network: channel.network, body: p.body, scheduledAt: when }, now).filter((i) => i.code.startsWith('schedule.'));
      if (issues.length) return fail('invalid', issues[0].message);
      const busy = this.posts.filter((o) => o.id !== p.id && o.channelId === p.channelId && ['scheduled', 'publishing', 'published'].includes(o.status)
        && day(o.status === 'published' ? o.publishedAt ?? o.updatedAt : o.scheduledAt ?? o.updatedAt) === day(when)).length;
      if (busy >= LIMITS.maxPostsPerChannelPerDay) return fail('channel_daily_limit', `This channel already has ${LIMITS.maxPostsPerChannelPerDay} posts for that day. Choose another day.`);
      next = { ...next, scheduledAt: new Date(when).toISOString() };
    }
    if (to === 'publishing') {
      if (p.attemptCount >= LIMITS.maxAttempts) return fail('too_many_attempts', `This post has been tried ${LIMITS.maxAttempts} times. Please check the channel, then write a new post.`);
      next = { ...next, scheduledAt: null };
    }
    if (to === 'approved' && (p.status === 'scheduled')) next = { ...next, scheduledAt: null };
    if (to === 'approved' && p.status === 'failed' && this.hashOf(p) !== p.approvedHash) {
      return fail('changed_after_approval', 'The text changed after it was approved. It needs to be approved again.');
    }
    if (to === 'draft') next = { ...next, approvedBy: null, approvedAt: null, approvedHash: null, scheduledAt: null };
    return ok(this.replace(this.stamp(next)));
  }

  setChannelStatus(actor: Actor, channelId: string, status: 'active' | 'paused'): Result<Channel> {
    const allowed = this.permission(actor, ['edit']);
    if (!allowed.ok) return allowed;
    const c = this.channel(channelId);
    if (!c) return fail('no_channel', 'That channel does not exist.');
    if (c.status !== 'active' && c.status !== 'paused') return fail('channel_unavailable', 'This channel is not connected, so it cannot be paused or resumed here.');
    c.status = status;
    return ok({ ...c });
  }

  // -- the system's part (what the publishing worker does) -----------------------------------
  /** Scheduled posts whose time has come move to "publishing". */
  startDue(): SocialPost[] {
    const now = this.now().getTime();
    const started: SocialPost[] = [];
    for (const p of this.posts) {
      if (p.status === 'scheduled' && p.scheduledAt && new Date(p.scheduledAt).getTime() <= now) {
        started.push(this.replace(this.stamp({ ...p, status: 'publishing' })));
      }
    }
    return started;
  }

  /** Publish one post that is in "publishing". Safe to call twice: the second call does nothing. */
  async publish(postId: string, provider: SocialProvider): Promise<Result<SocialPost>> {
    const p = this.post(postId);
    if (!p) return fail('not_found', 'That post does not exist.');
    if (p.status !== 'publishing') return fail('not_publishing', 'This post is not waiting to be published.');
    const channel = this.channel(p.channelId)!;
    const attempt = { ...p, attemptCount: p.attemptCount + 1 };
    if (this.hashOf(p) !== p.approvedHash) {
      return ok(this.replace(this.stamp({ ...attempt, status: 'failed', lastError: 'The text no longer matches what was approved, so it was not published.' })));
    }
    let outcome;
    try {
      outcome = await provider.publish({ idempotencyKey: `post:${p.id}`, channelExternalId: channel.externalId, network: channel.network, body: p.body, imageAlt: p.imageAlt });
    } catch {
      outcome = { ok: false as const, code: 'temporary' as const, message: 'Something went wrong while publishing. It is safe to try again.' };
    }
    if (outcome.ok) {
      return ok(this.replace(this.stamp({ ...attempt, status: 'published', publishedAt: outcome.publishedAt, externalPostId: outcome.externalPostId, lastError: null })));
    }
    return ok(this.replace(this.stamp({ ...attempt, status: 'failed', lastError: outcome.message })));
  }
}
