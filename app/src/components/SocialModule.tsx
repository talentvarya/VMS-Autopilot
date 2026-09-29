'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import { CalendarClock, Plus, ShieldCheck } from 'lucide-react';
import { decide } from '@/lib/permissions';
import { dateLabel, dayKey, shiftMonth } from '@/lib/social/calendar';
import { FIXTURE_NOW, SAMPLE_WORKSPACES } from '@/lib/social/fixtures';
import { processMemoryPublish } from '@/lib/social/memory-worker';
import { SandboxProvider } from '@/lib/social/sandbox-provider';
import { SocialStore, type Actor } from '@/lib/social/store';
import { POST_STATUSES, POST_STATUS_LABELS, type PostStatus } from '@/lib/social/types';
import { Title } from './dashboard/parts';
import CalendarView from './social/CalendarView';
import ChannelsPanel from './social/ChannelsPanel';
import Composer, { type RealClient } from './social/Composer';
import PostItem from './social/PostItem';

/**
 * Social Publishing (Phase 3) - SANDBOX ONLY.
 *
 * Everything here runs on invented workspaces against a pretend provider. Nothing is sent to
 * Buffer or any social network, and there is no login to one. What each person may do is decided
 * by the same permission rules the database enforces.
 */

type Preview = 'admin' | 'client-view' | 'client-write';

const ACTORS: Record<Preview, Actor> = {
  admin: { id: 'admin-1', role: 'admin', grants: [] },
  'client-view': { id: 'client-nova', role: 'client', grants: [] },
  'client-write': { id: 'client-nova', role: 'client', grants: [{ module: 'social', action: 'create' }, { module: 'social', action: 'edit' }, { module: 'social', action: 'approve' }] },
};

const PEOPLE: Record<string, string> = {
  'admin-1': 'Agency Admin', 'client-nova': 'Client team', 'client-2': 'Second reviewer', 'agency-writer': 'Agency writer',
};
const authorName = (id: string) => PEOPLE[id] ?? 'Team member';

const ORDER: PostStatus[] = ['in_review', 'failed', 'draft', 'approved', 'scheduled', 'publishing', 'published', 'cancelled'];

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 900px)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

export default function SocialModule({ notify, realClients = [], initialPreview = 'admin' }: { notify: (text: string) => void; realClients?: RealClient[]; initialPreview?: Preview }) {
  const [preview, setPreview] = useState<Preview>(initialPreview);
  const [workspaceId, setWorkspaceId] = useState(SAMPLE_WORKSPACES[0].id);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const clock = useRef(new Date(FIXTURE_NOW));
  const [month, setMonth] = useState(() => ({ year: clock.current.getUTCFullYear(), month0: clock.current.getUTCMonth() }));
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | PostStatus>('all');
  const [composing, setComposing] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const narrow = useNarrow();

  // One store and one pretend provider per sample workspace, created once.
  const [workspaces] = useState(() =>
    Object.fromEntries(
      SAMPLE_WORKSPACES.map((w) => {
        const store = new SocialStore({ now: () => clock.current, channels: w.channels, plan: w.plan, posts: w.posts, newId: (() => { let n = 0; return () => `${w.id}-new-${++n}`; })() });
        const provider = new SandboxProvider({
          plan: w.plan, now: () => clock.current,
          channels: w.channels.map((c) => ({ externalId: c.externalId, network: c.network, displayName: c.displayName, handle: c.handle, status: c.status })),
        });
        return [w.id, { store, provider, label: w.label }];
      }),
    ),
  );
  const { store, provider } = workspaces[workspaceId];
  const actor = ACTORS[preview];
  const principal = { role: actor.role, grants: actor.grants };
  const canCreate = decide(principal, 'social', 'create').effect === 'allow';
  const canEdit = decide(principal, 'social', 'edit').effect === 'allow';
  const isAdmin = actor.role === 'admin';

  useEffect(() => {
    if (focusId) { document.getElementById(focusId)?.focus(); setFocusId(null); }
  }, [focusId, openId]);

  const counts = Object.fromEntries(POST_STATUSES.map((s) => [s, store.posts.filter((p) => p.status === s).length])) as Record<PostStatus, number>;
  const shown = store.posts
    .filter((p) => filter === 'all' || p.status === filter)
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt));

  const say = (text: string) => notify(text);

  const runTransition = async (postId: string, to: PostStatus, options?: { scheduledAt?: string }) => {
    const from = store.post(postId)?.status;
    const r = store.transition(actor, postId, to, options);
    if (!r.ok) { say(r.message); bump(); return; }
    if (to === 'publishing') {
      // Show the "Publishing" status right away, before waiting for the sandbox to answer -
      // otherwise the post would briefly still show its old buttons while it is mid-flight.
      bump();
      const done = await processMemoryPublish(store, provider, postId);
      say(done.status === 'published' ? 'Published in the sandbox. Nothing was posted anywhere.' : `Publishing did not work: ${done.lastError}`);
    } else {
      const said: Record<string, string> = {
        'draft>in_review': 'Sent for approval', 'in_review>approved': 'Approved', 'approved>scheduled': 'Scheduled',
        'scheduled>approved': 'Unscheduled. The post is approved and waiting.', 'failed>approved': 'Ready to try again',
      };
      say(said[`${from}>${to}`] ?? (to === 'cancelled' ? 'Post cancelled' : to === 'draft' ? 'Sent back to draft' : 'Done'));
    }
    bump();
  };

  const saveDrafts = ({ channelIds, body, imageAlt }: { channelIds: string[]; body: string; imageAlt: string }) => {
    const r = store.createDrafts(actor, { channelIds, body, imageAlt });
    if (!r.ok) { say(r.message); return false; }
    say(r.value.length > 1 ? `${r.value.length} drafts saved` : 'Draft saved');
    setOpenId(r.value[0].id);
    setFilter('all');
    setFocusId(`soc-toggle-${r.value[0].id}`);
    bump();
    return true;
  };

  const editPost = (postId: string, changes: { body: string; imageAlt: string }) => {
    const r = store.edit(actor, postId, changes);
    if (!r.ok) { say(r.message); return false; }
    say(r.value.status === 'draft' ? 'Changes saved. The post is a draft again and needs approving.' : 'Changes saved');
    bump();
    return true;
  };

  const toggleChannel = (channelId: string, status: 'active' | 'paused') => {
    const r = store.setChannelStatus(actor, channelId, status);
    say(r.ok ? (status === 'paused' ? 'Channel paused. Nothing will be published to it.' : 'Channel resumed') : r.message);
    bump();
  };

  const addSampleChannel = () => {
    const n = store.channels.length + 1;
    try {
      provider.addChannel({ externalId: `sandbox-sample-${n}`, network: 'x', displayName: `Sample channel ${n}`, handle: `@sample${n}`, status: 'active' });
      store.channels = [...store.channels, { id: `${workspaceId}-sample-${n}`, workspaceId, network: 'x', externalId: `sandbox-sample-${n}`, displayName: `Sample channel ${n}`, handle: `@sample${n}`, status: 'active' }];
      say('Sample channel added');
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not add the channel.');
    }
    bump();
  };

  const advanceClock = () => {
    clock.current = new Date(clock.current.getTime() + 24 * 3600_000);
    say(`Sample date is now ${dateLabel(clock.current.toISOString())}`);
    bump();
  };

  const runDue = async () => {
    const started = store.startDue();
    let published = 0;
    for (const p of started) if ((await processMemoryPublish(store, provider, p.id)).status === 'published') published++;
    say(started.length === 0 ? 'No posts are due yet.' : `${started.length} post${started.length === 1 ? '' : 's'} due: ${published} published in the sandbox.`);
    bump();
  };

  const selectFromCalendar = (id: string) => {
    setFilter('all');
    setOpenId(id);
    setFocusId(`soc-toggle-${id}`);
  };

  return (
    <div className="soc">
      <div className="seo-toolbar">
        <div className="seo-field">
          <label htmlFor="soc-workspace">Client</label>
          <select id="soc-workspace" value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setOpenId(null); setFilter('all'); setComposing(false); }}>
            {SAMPLE_WORKSPACES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </div>
        <div className="seo-actions">
          {canCreate && (
            <button type="button" className="primary" onClick={() => { setComposing(true); }} aria-expanded={composing}>
              <Plus size={16} aria-hidden="true" /> New post
            </button>
          )}
        </div>
      </div>
      <p className="seo-badge-sample">
        <ShieldCheck size={15} aria-hidden="true" /> Sandbox: these are invented clients and channels. Nothing is connected to Buffer or to any social network, and publishing here only pretends.
      </p>
      {!canCreate && (
        <p className="seo-note">You can look at the channels, the calendar and every post. Your agency writes and schedules posts. Ask them if you would like to write drafts or approve posts.</p>
      )}

      {process.env.NODE_ENV !== 'production' && (
        <fieldset className="seo-preview">
          <legend>Demo preview (development only)</legend>
          <label><input type="radio" name="soc-role" checked={preview === 'admin'} onChange={() => setPreview('admin')} /> View as Admin</label>
          <label><input type="radio" name="soc-role" checked={preview === 'client-view'} onChange={() => setPreview('client-view')} /> View as Client (view only)</label>
          <label><input type="radio" name="soc-role" checked={preview === 'client-write'} onChange={() => setPreview('client-write')} /> View as Client (allowed to write and approve)</label>
        </fieldset>
      )}

      {isAdmin && (
        <div className="soc-sample">
          <span><CalendarClock size={15} aria-hidden="true" /> Sample date: <strong>{dateLabel(clock.current.toISOString())}</strong></span>
          <button type="button" className="outline soc-btn" onClick={advanceClock}>Move the sample date forward one day</button>
          <button type="button" className="outline soc-btn" onClick={runDue}>Check for posts that are due</button>
        </div>
      )}

      {composing && canCreate && (
        <Composer channels={store.channels} now={clock.current} onSave={saveDrafts} onCancel={() => { setComposing(false); setFocusId(null); }} realClients={realClients} notify={notify} />
      )}

      <div className="two-col">
        <ChannelsPanel channels={store.channels} plan={store.plan} canPause={canEdit} isAdmin={isAdmin} onToggle={toggleChannel} onAddSample={addSampleChannel} />
        <CalendarView
          posts={store.posts} channels={store.channels} year={month.year} month0={month.month0} today={dayKey(clock.current)}
          narrow={narrow} selectedId={openId} onSelect={selectFromCalendar} onMonth={(by) => setMonth((m) => shiftMonth(m.year, m.month0, by))}
        />
      </div>

      <section className="card">
        <Title text="Posts" />
        <div className="soc-summary" role="group" aria-label="Filter posts by status">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All ({store.posts.length})</button>
          {ORDER.filter((s) => counts[s] > 0).map((s) => (
            <button key={s} type="button" className={s} aria-pressed={filter === s} onClick={() => setFilter(s)}>
              {POST_STATUS_LABELS[s]} ({counts[s]})
            </button>
          ))}
        </div>
        <p className="seo-count" aria-live="polite">{shown.length} post{shown.length === 1 ? '' : 's'} shown for {workspaces[workspaceId].label}</p>
        {shown.length === 0 ? (
          <p className="soc-empty-note">No posts here yet.{canCreate ? ' Choose “New post” to write one.' : ''}</p>
        ) : (
          <ul className="soc-posts">
            {shown.map((p) => (
              <PostItem
                key={p.id} post={p} channel={store.channel(p.channelId)!} actor={actor} expanded={openId === p.id} now={clock.current}
                authorName={authorName} onToggle={() => setOpenId(openId === p.id ? null : p.id)}
                onTransition={(to, options) => runTransition(p.id, to, options)} onEdit={(changes) => editPost(p.id, changes)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
