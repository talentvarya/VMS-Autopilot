'use client';

import { useEffect, useState } from 'react';
import { decide } from '@/lib/permissions';
import { dateTimeLabel, dateLabel } from '@/lib/social/calendar';
import { EDITABLE, TRANSITIONS, requirementFor } from '@/lib/social/state';
import type { Actor } from '@/lib/social/store';
import { NETWORK_LABELS, POST_STATUS_LABELS, type Channel, type PostStatus, type SocialPost } from '@/lib/social/types';
import { validatePost } from '@/lib/social/validate';

interface ActionInfo { label: string; confirm?: string; needsTime?: boolean; primary?: boolean }

/** Wording for each move a person can make. Moves without an entry are not offered as buttons. */
const ACTIONS: Record<string, ActionInfo> = {
  'draft>in_review': { label: 'Send for approval', primary: true },
  'draft>cancelled': { label: 'Cancel post', confirm: 'Cancel this post? It will not be published.' },
  'in_review>approved': { label: 'Approve', primary: true, confirm: 'Approve exactly this text? If anyone changes it afterwards it goes back to draft and needs approving again.' },
  'in_review>draft': { label: 'Send back to draft' },
  'in_review>cancelled': { label: 'Cancel post', confirm: 'Cancel this post? It will not be published.' },
  'approved>scheduled': { label: 'Schedule…', primary: true, needsTime: true, confirm: 'Choose when this should go out. In this sandbox nothing is really posted.' },
  'approved>publishing': { label: 'Publish now (sandbox)', confirm: 'Publish this now? In this sandbox nothing is really posted anywhere.' },
  'approved>cancelled': { label: 'Cancel post', confirm: 'Cancel this post? It will not be published.' },
  'scheduled>approved': { label: 'Unschedule' },
  'scheduled>cancelled': { label: 'Cancel post', confirm: 'Cancel this scheduled post? It will not be published.' },
  'failed>approved': { label: 'Try again', primary: true },
  'failed>draft': { label: 'Back to draft' },
  'failed>cancelled': { label: 'Cancel post', confirm: 'Cancel this post? It will not be published.' },
};

export default function PostItem({
  post, channel, actor, expanded, now, authorName, onToggle, onTransition, onEdit,
}: {
  post: SocialPost;
  channel: Channel;
  actor: Actor;
  expanded: boolean;
  now: Date;
  authorName: (id: string) => string;
  onToggle: () => void;
  onTransition: (to: PostStatus, options?: { scheduledAt?: string }) => void;
  onEdit: (changes: { body: string; imageAlt: string }) => boolean;
}) {
  const [pending, setPending] = useState<PostStatus | null>(null);
  const [when, setWhen] = useState('');
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(post.body);
  const [draftAlt, setDraftAlt] = useState(post.imageAlt ?? '');
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (focusId) { document.getElementById(focusId)?.focus(); setFocusId(null); }
  }, [focusId, pending, editing]);

  const principal = { role: actor.role, grants: actor.grants };
  const allowedTo = (to: PostStatus) => {
    const need = requirementFor(post.status, to);
    return need !== null && need !== 'server' && need.some((a) => decide(principal, 'social', a).effect === 'allow');
  };
  const options = (Object.keys(TRANSITIONS[post.status]) as PostStatus[]).filter((to) => ACTIONS[`${post.status}>${to}`] && allowedTo(to));
  const canEdit = decide(principal, 'social', 'edit').effect === 'allow' && EDITABLE.includes(post.status);
  const finished = post.status === 'published' || post.status === 'cancelled';
  const issues = finished ? [] : validatePost({ network: channel.network, body: post.body, imageAlt: post.imageAlt }, now);
  const id = (part: string) => `soc-${part}-${post.id}`;
  const defaultWhen = new Date(now.getTime() + 24 * 3600_000).toISOString().slice(0, 16);

  const start = (to: PostStatus) => {
    const info = ACTIONS[`${post.status}>${to}`];
    if (info.confirm) { setPending(to); setWhen(defaultWhen); setFocusId(id('cancel')); }
    else { onTransition(to); setFocusId(id('toggle')); }
  };
  const confirm = (to: PostStatus) => {
    const info = ACTIONS[`${post.status}>${to}`];
    if (info.needsTime && !when) return;
    onTransition(to, info.needsTime ? { scheduledAt: new Date(when + ':00Z').toISOString() } : undefined);
    setPending(null);
    setFocusId(id('toggle'));
  };
  const cancelPending = () => { const to = pending; setPending(null); setFocusId(to ? id(`act-${to}`) : id('toggle')); };

  return (
    <li className={'soc-post ' + post.status + (expanded ? ' open' : '')} id={id('item')}>
      <h4 className="soc-post-head">
        <button type="button" id={id('toggle')} aria-expanded={expanded} aria-controls={id('body')} onClick={onToggle}>
          <span className={'soc-net ' + channel.network}>{NETWORK_LABELS[channel.network]}</span>
          <span className="soc-post-snippet">{post.body}</span>
          <span className={'soc-status ' + post.status}>{POST_STATUS_LABELS[post.status]}</span>
        </button>
      </h4>
      {expanded && (
        <div className="soc-post-body" id={id('body')}>
          {editing ? (
            <div className="soc-edit">
              <div className="seo-field">
                <label htmlFor={id('text')}>Text</label>
                <textarea id={id('text')} rows={4} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
              </div>
              <div className="seo-field">
                <label htmlFor={id('alt')}>Picture description (optional)</label>
                <input id={id('alt')} type="text" value={draftAlt} onChange={(e) => setDraftAlt(e.target.value)} />
              </div>
              {post.status !== 'draft' && <p className="soc-hint">Changing the words sends this post back to draft. It will need approving again.</p>}
              <div className="soc-actions">
                <button type="button" className="primary soc-btn" onClick={() => { if (onEdit({ body: draftBody, imageAlt: draftAlt })) { setEditing(false); setFocusId(id('toggle')); } }}>Save changes</button>
                <button type="button" className="outline soc-btn" onClick={() => { setEditing(false); setDraftBody(post.body); setDraftAlt(post.imageAlt ?? ''); setFocusId(id('edit')); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <p className="soc-text">{post.body}</p>
              {post.imageAlt && <p className="soc-hint">Picture description: {post.imageAlt}</p>}
            </>
          )}

          <dl className="soc-facts">
            <div><dt>Written by</dt><dd>{authorName(post.createdBy)} on {dateLabel(post.createdAt)}</dd></div>
            {post.approvedAt && <div><dt>Approved by</dt><dd>{authorName(post.approvedBy!)} on {dateLabel(post.approvedAt)}</dd></div>}
            {post.scheduledAt && <div><dt>Goes out</dt><dd>{dateTimeLabel(post.scheduledAt)}</dd></div>}
            {post.publishedAt && <div><dt>Published</dt><dd>{dateTimeLabel(post.publishedAt)} (sandbox: nothing was really posted)</dd></div>}
            {post.attemptCount > 0 && <div><dt>Tries</dt><dd>{post.attemptCount} of 3</dd></div>}
          </dl>
          {post.lastError && <p className="soc-problem" role="note">{post.lastError}</p>}
          {issues.length > 0 && (
            <ul className="soc-issues">
              {issues.map((i) => (
                <li key={i.code} className={i.level}><b>{i.level === 'error' ? 'Please fix: ' : 'Please check: '}</b>{i.message}</li>
              ))}
            </ul>
          )}

          {pending ? (
            <div className="seo-confirm" role="group" aria-label={`Confirm: ${ACTIONS[`${post.status}>${pending}`].label}`}>
              <span>{ACTIONS[`${post.status}>${pending}`].confirm}</span>
              {ACTIONS[`${post.status}>${pending}`].needsTime && (
                <span className="seo-field">
                  <label htmlFor={id('when')}>Date and time (UTC)</label>
                  <input id={id('when')} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                </span>
              )}
              <button type="button" className="primary soc-btn" onClick={() => confirm(pending)}>Yes, {ACTIONS[`${post.status}>${pending}`].label.replace('…', '').toLowerCase()}</button>
              <button type="button" id={id('cancel')} className="outline soc-btn" onClick={cancelPending}>Go back</button>
            </div>
          ) : (
            <div className="soc-actions">
              {options.map((to) => {
                const info = ACTIONS[`${post.status}>${to}`];
                return (
                  <button key={to} type="button" id={id(`act-${to}`)} className={(info.primary ? 'primary' : 'outline') + ' soc-btn'} onClick={() => start(to)} aria-label={`${info.label}: ${post.body.slice(0, 40)}`}>
                    {info.label}
                  </button>
                );
              })}
              {canEdit && !editing && (
                <button type="button" id={id('edit')} className="outline soc-btn" onClick={() => { setEditing(true); setDraftBody(post.body); setDraftAlt(post.imageAlt ?? ''); setFocusId(id('text')); }} aria-label={`Edit text: ${post.body.slice(0, 40)}`}>
                  Edit text
                </button>
              )}
              {(options.length === 0 || (actor.role === 'client' && ['approved', 'scheduled', 'failed'].includes(post.status))) && <p className="soc-hint">{explain(post.status, actor)}</p>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Plain-words reason there is nothing to press. */
function explain(status: PostStatus, actor: Actor): string {
  if (status === 'published') return 'This post is published (in the sandbox). It cannot be changed.';
  if (status === 'cancelled') return 'This post was cancelled.';
  if (status === 'publishing') return 'This post is being published right now.';
  if (actor.role === 'client') return 'Your agency looks after scheduling and publishing. You can ask them if you need anything changed.';
  return 'There is nothing you can do with this post right now.';
}
