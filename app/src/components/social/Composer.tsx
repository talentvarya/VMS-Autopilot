'use client';

import { useEffect, useRef, useState } from 'react';
import { NETWORK_LIMITS, charLength } from '@/lib/social/networks';
import { NETWORK_LABELS, type Channel } from '@/lib/social/types';
import { hasErrors, validatePost } from '@/lib/social/validate';
import { Title } from '../dashboard/parts';

export default function Composer({
  channels, now, onSave, onCancel,
}: {
  channels: Channel[];
  now: Date;
  onSave: (input: { channelIds: string[]; body: string; imageAlt: string }) => boolean;
  onCancel: () => void;
}) {
  const usable = channels.filter((c) => c.status === 'active' || c.status === 'paused');
  const [chosen, setChosen] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [alt, setAlt] = useState('');
  const [tried, setTried] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => bodyRef.current?.focus(), []);

  const selected = usable.filter((c) => chosen.includes(c.id));
  const perNetwork = selected.map((c) => ({ channel: c, issues: validatePost({ network: c.network, body, imageAlt: alt }, now) }));
  const blocking = perNetwork.some((p) => hasErrors(p.issues)) || chosen.length === 0 || body.trim() === '';

  const submit = () => {
    setTried(true);
    if (blocking) return;
    if (onSave({ channelIds: chosen, body, imageAlt: alt })) { setBody(''); setAlt(''); setChosen([]); setTried(false); }
  };

  return (
    <section className="card soc-composer">
      <Title text="New post" />
      <fieldset className="soc-choose">
        <legend>Where should it go?</legend>
        {usable.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))} />
            {NETWORK_LABELS[c.network]}: {c.displayName}{c.status === 'paused' ? ' (paused)' : ''}
          </label>
        ))}
      </fieldset>
      {tried && chosen.length === 0 && <p className="soc-problem" role="alert">Choose at least one channel.</p>}

      <div className="seo-field">
        <label htmlFor="soc-body">Text</label>
        <textarea id="soc-body" ref={bodyRef} rows={5} value={body} onChange={(e) => setBody(e.target.value)} aria-describedby="soc-counts" />
      </div>
      <div className="seo-field">
        <label htmlFor="soc-alt">Picture description (optional)</label>
        <input id="soc-alt" type="text" value={alt} onChange={(e) => setAlt(e.target.value)} aria-describedby="soc-alt-help" />
        <p id="soc-alt-help" className="soc-hint">Pictures and video can be added in a later version. If you plan to add a picture, describe it here for people who cannot see it.</p>
      </div>

      <div id="soc-counts" className="soc-counts" aria-live="polite">
        {perNetwork.length === 0 && <p className="soc-hint">Choose a channel to see its length limit and any suggestions.</p>}
        {perNetwork.map(({ channel, issues }) => (
          <div key={channel.id} className="soc-count-row">
            <strong>{NETWORK_LABELS[channel.network]}</strong>
            <span>{charLength(body).toLocaleString('en-US')} of {NETWORK_LIMITS[channel.network].maxChars.toLocaleString('en-US')} characters</span>
            {issues.length > 0 && (
              <ul>
                {issues.map((i) => (
                  <li key={i.code} className={i.level}><b>{i.level === 'error' ? 'Please fix: ' : 'Please check: '}</b>{i.message}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {tried && body.trim() === '' && <p className="soc-problem" role="alert">Write something first.</p>}

      <div className="soc-actions">
        <button type="button" className="primary soc-btn" onClick={submit} aria-disabled={blocking && tried ? true : undefined}>Save draft</button>
        <button type="button" className="outline soc-btn" onClick={onCancel}>Close</button>
      </div>
    </section>
  );
}
