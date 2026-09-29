'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { NETWORK_LIMITS, charLength } from '@/lib/social/networks';
import { NETWORK_LABELS, type Channel } from '@/lib/social/types';
import { hasErrors, validatePost } from '@/lib/social/validate';
import { Title } from '../dashboard/parts';

export interface RealClient {
  id: string;
  name: string;
}

export default function Composer({
  channels, now, onSave, onCancel, realClients, notify,
}: {
  channels: Channel[];
  now: Date;
  onSave: (input: { channelIds: string[]; body: string; imageAlt: string }) => boolean;
  onCancel: () => void;
  /** The app's real clients (Clients tab) - separate from this sandbox's own fixture
   * "workspaces", needed only to attribute and cap the cost of a real AI call. */
  realClients: RealClient[];
  notify: (text: string) => void;
}) {
  const usable = channels.filter((c) => c.status === 'active' || c.status === 'paused');
  const [chosen, setChosen] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [alt, setAlt] = useState('');
  const [tried, setTried] = useState(false);
  const [generating, setGenerating] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => bodyRef.current?.focus(), []);

  const generateWithAi = async () => {
    if (realClients.length === 0) {
      notify('Add a real client first (Clients tab) - AI captions are billed per client.');
      return;
    }
    const network = usable.find(c => chosen.includes(c.id))?.network;
    if (!network) {
      notify('Choose a channel first, so the caption fits that network.');
      return;
    }
    const typed = window.prompt(`Which client is this for? (${realClients.map(c => c.name).join(', ')})`)?.trim().toLowerCase();
    if (!typed) return;
    const client = realClients.find(c => c.name.toLowerCase() === typed);
    if (!client) {
      notify('No client matches that name');
      return;
    }
    const topic = window.prompt('What is the post about?')?.trim();
    if (!topic) return;
    const callToAction = window.prompt('Call to action? (optional)')?.trim() || undefined;

    setGenerating(true);
    try {
      const res = await fetch('/api/social/generate-caption', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: client.id, network, topic, callToAction }),
      });
      const result = await res.json();
      if (!res.ok) {
        notify(result.error || 'Could not generate a caption');
        return;
      }
      setBody(result.text as string);
      notify('AI draft ready - review and edit before saving');
    } catch {
      notify('Could not generate a caption — check your connection');
    } finally {
      setGenerating(false);
    }
  };

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
        <button type="button" className="outline soc-btn" onClick={generateWithAi} disabled={generating} style={{ marginTop: 8 }}>
          <Sparkles size={15} aria-hidden="true" /> {generating ? 'Writing…' : 'Generate with AI'}
        </button>
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
