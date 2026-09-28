import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW, SAMPLE_WORKSPACES } from '@/lib/social/fixtures';
import { DuplicateChannelError, PlanLimitReachedError, SandboxProvider } from '@/lib/social/sandbox-provider';
import { LIVE_SOCIAL_ENABLED, LiveSocialDisabledError, createProvider } from '@/lib/social/sources';
import { SocialStore, type Actor } from '@/lib/social/store';
import { LIMITS } from '@/lib/social/types';
import type { ProviderChannel } from '@/lib/social/provider';

const NOW = new Date(FIXTURE_NOW);
const admin: Actor = { id: 'admin-1', role: 'admin', grants: [] };
const viewer: Actor = { id: 'client-nova', role: 'client', grants: [] }; // default client: view only
const writer: Actor = { id: 'client-nova', role: 'client', grants: [{ module: 'social', action: 'create' }, { module: 'social', action: 'edit' }] };
const approver: Actor = { id: 'client-2', role: 'client', grants: [{ module: 'social', action: 'approve' }] };
const plusHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

function newStore(workspaceIndex = 0) {
  const w = SAMPLE_WORKSPACES[workspaceIndex];
  let clock = NOW;
  const store = new SocialStore({ now: () => clock, channels: w.channels, plan: w.plan, posts: w.posts.map((p) => ({ ...p })), newId: (() => { let n = 0; return () => `t${++n}`; })() });
  const provider = new SandboxProvider({ plan: w.plan, channels: w.channels.map((c) => ({ externalId: c.externalId, network: c.network, displayName: c.displayName, handle: c.handle, status: c.status })), now: () => clock });
  return { store, provider, setNow: (d: Date) => { clock = d; } };
}
const okv = <T,>(r: { ok: boolean; value?: T; message?: string }): T => {
  if (!r.ok) throw new Error('expected ok, got: ' + r.message);
  return r.value as T;
};
/** Draft -> approved, ready to schedule. */
function approvedPost(store: SocialStore, body = 'Come and see our new opening hours this week.', channelId = 'nova-fb') {
  const draft = okv(store.createDraft(admin, { channelId, body }));
  okv(store.transition(admin, draft.id, 'in_review'));
  okv(store.transition(admin, draft.id, 'approved'));
  return store.post(draft.id)!;
}

describe('going live is switched off', () => {
  it('has the switch off and cannot create a Buffer provider', () => {
    expect(LIVE_SOCIAL_ENABLED).toBe(false);
    expect(() => createProvider('buffer')).toThrow(LiveSocialDisabledError);
    expect(() => createProvider('buffer')).toThrow(/switched off/);
    expect(createProvider('sandbox').kind).toBe('sandbox');
  });

  it('has no network, Buffer or token code anywhere in the social folder', () => {
    const dir = join(__dirname, '..', '..', 'src', 'lib', 'social');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|node:https?|node:net|node:dns|WebSocket|child_process|process\.env|access_?token|api_?key|bufferapp|buffer\.com|oauth/i);
    }
  });
});

describe('the sandbox provider (a pretend Buffer)', () => {
  const ch = (id: string, network: ProviderChannel['network'] = 'facebook'): ProviderChannel => ({ externalId: id, network, displayName: id, handle: id, status: 'active' });

  it('enforces the plan’s channel limit and never lets a channel be added twice', async () => {
    const p = new SandboxProvider({ plan: { tier: 'free', name: 'Free', channelLimit: 2 } });
    p.addChannel(ch('a'));
    expect(() => p.addChannel(ch('a'))).toThrow(DuplicateChannelError);
    p.addChannel(ch('b'));
    expect(() => p.addChannel(ch('c'))).toThrow(PlanLimitReachedError);
    expect(() => p.addChannel(ch('c'))).toThrow(/upgrade the plan/);
    expect((await p.getPlan()).channelLimit).toBe(2);
    expect(await p.listChannels()).toHaveLength(2);
  });

  it('publishes once, and answers the same for a repeated request without delivering twice', async () => {
    const p = new SandboxProvider({ channels: [ch('a')], now: () => NOW });
    const req = { idempotencyKey: 'post:1', channelExternalId: 'a', network: 'facebook' as const, body: 'Hello' };
    const first = await p.publish(req);
    const second = await p.publish(req);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(p.deliveries.get('post:1')).toBe(1);
    expect(await p.publish({ ...req, idempotencyKey: 'post:2' })).toMatchObject({ ok: true });
    expect(p.deliveries.get('post:2')).toBe(1);
  });

  it('fails on command: rejected, rate-limited, temporary (then succeeds), paused, unknown, too long', async () => {
    const p = new SandboxProvider({ channels: [ch('a'), { ...ch('paused'), status: 'paused' }, { ...ch('gone'), status: 'disconnected' }] });
    const send = (body: string, key: string, channel = 'a', network: 'facebook' | 'x' = 'facebook') => p.publish({ idempotencyKey: key, channelExternalId: channel, network, body });
    expect(await send('x [sandbox:fail]', 'k1')).toMatchObject({ ok: false, code: 'rejected' });
    expect(await send('x [sandbox:ratelimit]', 'k2')).toMatchObject({ ok: false, code: 'rate_limited', retryAfterSeconds: 60 });
    expect(await send('x [sandbox:temporary]', 'k3')).toMatchObject({ ok: false, code: 'temporary' });
    expect(await send('x [sandbox:temporary]', 'k3')).toMatchObject({ ok: true });
    expect(await send('hi', 'k4', 'paused')).toMatchObject({ ok: false, code: 'channel_unavailable', message: expect.stringContaining('paused') });
    expect(await send('hi', 'k5', 'gone')).toMatchObject({ ok: false, code: 'channel_unavailable' });
    expect(await send('hi', 'k6', 'nobody')).toMatchObject({ ok: false, code: 'channel_unavailable' });
    p.addChannel({ ...ch('xx', 'x') });
    expect(await send('a'.repeat(281), 'k7', 'xx', 'x')).toMatchObject({ ok: false, code: 'rejected' });
    // a rejected post stays rejected on a repeat (it will not be retried by accident)
    expect(await send('x [sandbox:fail]', 'k1')).toMatchObject({ ok: false, code: 'rejected' });
  });

  it('writes clear, jargon-free failure messages', async () => {
    const p = new SandboxProvider({ channels: [ch('a')] });
    for (const marker of ['fail', 'ratelimit', 'temporary']) {
      const r = await p.publish({ idempotencyKey: marker, channelExternalId: 'a', network: 'facebook', body: `[sandbox:${marker}]` });
      if (!r.ok) expect(r.message).not.toMatch(/exception|null|undefined|stack|token|500|429/i);
    }
  });
});

describe('who can write and approve', () => {
  it('a default Client can only look', () => {
    const { store } = newStore();
    const r = store.createDraft(viewer, { channelId: 'nova-fb', body: 'Hello' });
    expect(r).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(store.transition(viewer, 'sample-7', 'approved')).toMatchObject({ ok: false });
  });

  it('a Client an Admin has allowed can write a draft and submit it, but not approve, schedule or publish', () => {
    const { store } = newStore();
    const draft = okv(store.createDraft(writer, { channelId: 'nova-fb', body: 'Our clinic is open late on Thursdays.' }));
    expect(draft.status).toBe('draft');
    expect(okv(store.transition(writer, draft.id, 'in_review')).status).toBe('in_review');
    expect(store.transition(writer, draft.id, 'approved')).toMatchObject({ ok: false, code: 'not_allowed' });
    okv(store.transition(admin, draft.id, 'approved'));
    for (const to of ['scheduled', 'publishing'] as const) {
      expect(store.transition(writer, draft.id, to, { scheduledAt: plusHours(48) })).toMatchObject({ ok: false });
    }
  });

  it('a Client can never publish, even if a grant were forged; a trusted team member is told it needs an Admin', () => {
    const { store } = newStore();
    const p = approvedPost(store);
    const forgedClient: Actor = { id: 'client-nova', role: 'client', grants: [{ module: 'social', action: 'publish_execute' }] };
    // publish/execute is above a Client's ceiling: not allowed at all, whatever grants exist
    expect(store.transition(forgedClient, p.id, 'publishing')).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(store.transition(forgedClient, p.id, 'scheduled', { scheduledAt: plusHours(48) })).toMatchObject({ ok: false, code: 'not_allowed' });
    // a team member may be trusted with it, but publishing is sensitive, so it still needs an Admin
    const team: Actor = { id: 'team-1', role: 'team_member', grants: [{ module: 'social', action: 'publish_execute' }] };
    expect(store.transition(team, p.id, 'publishing')).toMatchObject({ ok: false, code: 'needs_admin' });
    expect(store.post(p.id)!.status).toBe('approved');
  });

  it('the person who wrote a post cannot approve it (a second pair of eyes), unless they are the Admin', () => {
    const { store } = newStore();
    const both: Actor = { id: 'client-nova', role: 'client', grants: [{ module: 'social', action: 'create' }, { module: 'social', action: 'edit' }, { module: 'social', action: 'approve' }] };
    const draft = okv(store.createDraft(both, { channelId: 'nova-fb', body: 'Written and reviewed by the same person.' }));
    okv(store.transition(both, draft.id, 'in_review'));
    expect(store.transition(both, draft.id, 'approved')).toMatchObject({ ok: false, code: 'own_post' });
    expect(okv(store.transition(approver, draft.id, 'approved')).approvedBy).toBe('client-2');
    // an Admin approving their own work is fine: they are accountable for the account
    const mine = okv(store.createDraft(admin, { channelId: 'nova-fb', body: 'An Admin wrote this.' }));
    okv(store.transition(admin, mine.id, 'in_review'));
    expect(okv(store.transition(admin, mine.id, 'approved')).status).toBe('approved');
  });

  it('a post cannot skip approval', () => {
    const { store } = newStore();
    const d = okv(store.createDraft(admin, { channelId: 'nova-fb', body: 'Straight to the front page please.' }));
    for (const to of ['approved', 'scheduled', 'publishing', 'published'] as const) {
      expect(store.transition(admin, d.id, to, { scheduledAt: plusHours(48) })).toMatchObject({ ok: false, code: expect.stringMatching(/illegal|server_only/) });
    }
  });

  it('writes for several channels at once, or for none of them if one is not allowed', () => {
    const { store } = newStore(1);
    const made = okv(store.createDrafts(admin, { channelIds: ['bright-ig', 'bright-in'], body: 'Open house Saturday.' }));
    expect(made).toHaveLength(2);
    expect(new Set(made.map((p) => p.groupId)).size).toBe(1);
    expect(made[0].groupId).not.toBeNull();
    const before = store.posts.length;
    const r = store.createDrafts(admin, { channelIds: ['bright-ig', 'nope'], body: 'x' });
    expect(r.ok).toBe(false);
    expect(store.posts.length).toBe(before);
    expect(store.createDrafts(admin, { channelIds: [], body: 'x' })).toMatchObject({ ok: false });
  });
});

describe('approved means frozen', () => {
  it('editing an approved post sends it back to Draft and wipes the approval', () => {
    const { store } = newStore();
    const p = approvedPost(store);
    expect(p.approvedHash).toMatch(/^[0-9a-f]{64}$/);
    const edited = okv(store.edit(admin, p.id, { body: 'Slightly different words after approval.' }));
    expect(edited).toMatchObject({ status: 'draft', approvedBy: null, approvedAt: null, approvedHash: null, scheduledAt: null });
    expect(store.transition(admin, p.id, 'scheduled', { scheduledAt: plusHours(48) })).toMatchObject({ ok: false });
  });

  it('a scheduled post that is edited leaves the schedule too', () => {
    const { store } = newStore();
    const p = approvedPost(store);
    okv(store.transition(admin, p.id, 'scheduled', { scheduledAt: plusHours(48) }));
    expect(okv(store.edit(admin, p.id, { body: 'Changed my mind about the wording.' }))).toMatchObject({ status: 'draft', scheduledAt: null });
  });

  it('text swapped behind the scenes after approval is caught and never published', async () => {
    const { store, provider } = newStore();
    const p = approvedPost(store);
    // Someone changes the stored text without going through approval.
    store.posts = store.posts.map((x) => (x.id === p.id ? { ...x, body: 'Buy cheap watches at evil.test' } : x));
    expect(store.transition(admin, p.id, 'scheduled', { scheduledAt: plusHours(48) })).toMatchObject({ ok: false, code: 'changed_after_approval' });
    expect(store.transition(admin, p.id, 'publishing')).toMatchObject({ ok: false, code: 'changed_after_approval' });
    // ...and even if it reached "publishing" some other way, the last check stops it.
    store.posts = store.posts.map((x) => (x.id === p.id ? { ...x, status: 'publishing' as const } : x));
    const r = okv(await store.publish(p.id, provider));
    expect(r.status).toBe('failed');
    expect(r.lastError).toContain('no longer matches what was approved');
    expect([...provider.deliveries.values()]).toEqual([]); // nothing was delivered
  });

  it('published, publishing and cancelled posts cannot be edited', () => {
    const { store } = newStore();
    expect(store.edit(admin, 'sample-1', { body: 'Rewriting history' })).toMatchObject({ ok: false, code: 'locked' }); // published
    expect(store.edit(admin, 'nope', { body: 'x' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('an unchanged edit does nothing, and an empty or over-long edit is refused', () => {
    const { store } = newStore();
    const p = approvedPost(store);
    expect(okv(store.edit(admin, p.id, { body: p.body })).status).toBe('approved');
    expect(store.edit(admin, p.id, { body: '   ' })).toMatchObject({ ok: false, code: 'body_empty' });
    const tweet = okv(store.createDraft(admin, { channelId: 'nova-in', body: 'ok' }));
    expect(store.edit(admin, tweet.id, { body: 'a'.repeat(3001) })).toMatchObject({ ok: false, code: 'body_too_long' });
  });
});

describe('scheduling and publishing safely', () => {
  it('only accepts a time inside the window, and only for an active channel', () => {
    const { store } = newStore();
    const p = approvedPost(store);
    expect(store.transition(admin, p.id, 'scheduled', { scheduledAt: plusHours(0.03) })).toMatchObject({ ok: false, message: expect.stringContaining('at least 5 minutes') });
    expect(store.transition(admin, p.id, 'scheduled', { scheduledAt: plusHours(24 * 91) })).toMatchObject({ ok: false, message: expect.stringContaining('90 days') });
    expect(store.transition(admin, p.id, 'scheduled', {})).toMatchObject({ ok: false, code: 'schedule_missing' });
    okv(store.setChannelStatus(admin, 'nova-fb', 'paused'));
    expect(store.transition(admin, p.id, 'scheduled', { scheduledAt: plusHours(48) })).toMatchObject({ ok: false, code: 'channel_unavailable' });
    okv(store.setChannelStatus(admin, 'nova-fb', 'active'));
    expect(okv(store.transition(admin, p.id, 'scheduled', { scheduledAt: plusHours(48) })).status).toBe('scheduled');
  });

  it('stops a channel being flooded: at most 10 posts a day', () => {
    const { store } = newStore();
    const when = plusHours(72);
    for (let i = 0; i < LIMITS.maxPostsPerChannelPerDay; i++) {
      const p = approvedPost(store, `Scheduled post number ${i} for the flood test.`);
      okv(store.transition(admin, p.id, 'scheduled', { scheduledAt: when }));
    }
    const extra = approvedPost(store, 'One post too many for this one day.');
    expect(store.transition(admin, extra.id, 'scheduled', { scheduledAt: when })).toMatchObject({ ok: false, code: 'channel_daily_limit' });
    // another day is fine
    expect(okv(store.transition(admin, extra.id, 'scheduled', { scheduledAt: plusHours(72 + 24) })).status).toBe('scheduled');
  });

  it('caps new drafts per workspace per day', () => {
    const { store } = newStore();
    let refused = 0;
    for (let i = 0; i < LIMITS.maxNewPostsPerWorkspacePerDay + 5; i++) {
      if (!store.createDraft(admin, { channelId: 'nova-fb', body: `Draft ${i}` }).ok) refused++;
    }
    expect(refused).toBeGreaterThan(0);
    expect(store.createDraft(admin, { channelId: 'nova-fb', body: 'One more' })).toMatchObject({ ok: false, code: 'daily_limit' });
  });

  it('unscheduling returns the post to Approved with no time', () => {
    const { store } = newStore();
    const p = approvedPost(store);
    okv(store.transition(admin, p.id, 'scheduled', { scheduledAt: plusHours(48) }));
    expect(okv(store.transition(admin, p.id, 'approved'))).toMatchObject({ status: 'approved', scheduledAt: null });
  });

  it('publishes now: published, once, with the provider asked exactly once', async () => {
    const { store, provider } = newStore();
    const p = approvedPost(store);
    okv(store.transition(admin, p.id, 'publishing'));
    const done = okv(await store.publish(p.id, provider));
    expect(done).toMatchObject({ status: 'published', attemptCount: 1, lastError: null });
    expect(done.externalPostId).toMatch(/^sandbox-/);
    expect(await store.publish(p.id, provider)).toMatchObject({ ok: false, code: 'not_publishing' });
    expect(provider.deliveries.get(`post:${p.id}`)).toBe(1);
  });

  it('starts scheduled posts only when they are due', async () => {
    const { store, provider, setNow } = newStore();
    const p = approvedPost(store);
    okv(store.transition(admin, p.id, 'scheduled', { scheduledAt: plusHours(2) }));
    expect(store.startDue()).toEqual([]);
    setNow(new Date(NOW.getTime() + 3 * 3600_000));
    const started = store.startDue();
    expect(started.map((s) => s.id)).toEqual([p.id]);
    expect(okv(await store.publish(p.id, provider)).status).toBe('published');
    expect(store.startDue()).toEqual([]);
  });

  it('records a failure in plain words and allows a retry - but only three tries', async () => {
    const { store, provider } = newStore();
    const p = approvedPost(store, 'This one will be refused [sandbox:fail]');
    for (let attempt = 1; attempt <= LIMITS.maxAttempts; attempt++) {
      okv(store.transition(admin, p.id, 'publishing'));
      const r = okv(await store.publish(p.id, provider));
      expect(r).toMatchObject({ status: 'failed', attemptCount: attempt });
      expect(r.lastError).toContain('did not accept');
      if (attempt < LIMITS.maxAttempts) okv(store.transition(admin, p.id, 'approved'));
    }
    okv(store.transition(admin, p.id, 'approved'));
    expect(store.transition(admin, p.id, 'publishing')).toMatchObject({ ok: false, code: 'too_many_attempts' });
  });

  it('a temporary problem can be retried and does not post twice', async () => {
    const { store, provider } = newStore();
    const p = approvedPost(store, 'Sometimes the network hiccups [sandbox:temporary]');
    okv(store.transition(admin, p.id, 'publishing'));
    expect(okv(await store.publish(p.id, provider)).status).toBe('failed');
    okv(store.transition(admin, p.id, 'approved'));
    okv(store.transition(admin, p.id, 'publishing'));
    expect(okv(await store.publish(p.id, provider)).status).toBe('published');
    expect(provider.deliveries.get(`post:${p.id}`)).toBe(1);
  });

  it('turns a provider crash into a safe message', async () => {
    const { store } = newStore();
    const p = approvedPost(store);
    okv(store.transition(admin, p.id, 'publishing'));
    const broken = { kind: 'sandbox' as const, getPlan: async () => { throw new Error('x'); }, listChannels: async () => [], publish: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5 password=hunter2'); } };
    const r = okv(await store.publish(p.id, broken));
    expect(r.status).toBe('failed');
    expect(r.lastError).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2/);
  });

  it('lets an Admin pause and resume a connected channel, and nobody else without permission', () => {
    const { store } = newStore(1);
    expect(okv(store.setChannelStatus(admin, 'bright-ig', 'paused')).status).toBe('paused');
    expect(store.setChannelStatus(viewer, 'bright-ig', 'active')).toMatchObject({ ok: false });
    expect(okv(store.setChannelStatus(admin, 'bright-ig', 'active')).status).toBe('active');
    expect(store.setChannelStatus(admin, 'nope', 'paused')).toMatchObject({ ok: false });
  });
});
