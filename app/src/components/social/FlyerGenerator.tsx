'use client';

import { useEffect, useState } from 'react';
import { ImageIcon, Sparkles } from 'lucide-react';
import { Title } from '../dashboard/parts';
import type { RealClient } from './Composer';

/**
 * Phase G.8 - real AI flyer/creative images (OpenAI, approved 2026-09-30). Standalone from the
 * sandbox Composer on purpose: the sandbox post record has no image field yet (only imageAlt
 * text - see lib/social/types.ts), so attaching a generated image directly to a sandbox draft
 * needs its own, separate schema work. This gives the real image today - a real file the
 * agency can download and use anywhere - without pretending it is already wired into posting.
 *
 * Phase G.8b - OFF by default. Real generation costs the owner's own OpenAI account real
 * money, so nothing calls it until the Admin explicitly flips this toggle - their own choice,
 * made whenever they are ready to pay, not something turned on for them.
 */
export default function FlyerGenerator({ realClients, notify }: { realClients: RealClient[]; notify: (text: string) => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ imageRef: string; altText: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/agency-settings');
        const body = await res.json();
        if (!cancelled && res.ok) setEnabled(body.imageGenerationEnabled === true);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = async () => {
    setTogglingEnabled(true);
    const next = !enabled;
    try {
      const res = await fetch('/api/agency-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageGenerationEnabled: next }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not change that setting');
        return;
      }
      setEnabled(next);
      notify(next ? 'Image generation turned ON — this will now cost real money per image' : 'Image generation turned OFF');
    } catch {
      notify('Could not change that setting — check your connection');
    } finally {
      setTogglingEnabled(false);
    }
  };

  const generate = async () => {
    if (!enabled) {
      notify('Turn on image generation first');
      return;
    }
    if (realClients.length === 0) {
      notify('Add a real client first (Clients tab) - image generation is billed per client.');
      return;
    }
    if (!prompt.trim()) {
      notify('Describe the flyer first');
      return;
    }
    const typed = window.prompt(`Which client is this for? (${realClients.map(c => c.name).join(', ')})`)?.trim().toLowerCase();
    if (!typed) return;
    const client = realClients.find(c => c.name.toLowerCase() === typed);
    if (!client) {
      notify('No client matches that name');
      return;
    }

    setGenerating(true);
    setResult(null);
    try {
      const res = await fetch('/api/social/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: client.id, prompt }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not generate the image');
        return;
      }
      setResult({ imageRef: body.imageRef, altText: body.altText });
      notify('Flyer generated');
    } catch {
      notify('Could not generate the image — check your connection');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <section className="card">
      <Title
        text="AI Flyer Generator"
        right={
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={enabled === true} disabled={enabled === null || togglingEnabled} onChange={toggle} />
            {enabled ? 'On — real cost applies' : 'Off (default, no cost)'}
          </label>
        }
      />
      <p style={{ padding: '4px 0 12px', opacity: 0.7 }}>
        Describe the flyer you want (offer, business type, style) - a real image comes back for you to download and use.
        Not yet attached to a sandbox post automatically; save the file and add it yourself for now.
        {' '}<strong>Each image costs a small real amount on your own OpenAI account</strong> (roughly a few cents), capped at $1/client/month by default.
      </p>
      {enabled === false && (
        <p style={{ padding: '8px 0', opacity: 0.7 }}>Turn on the switch above whenever you are ready to generate a real, billed flyer.</p>
      )}
      <div className="seo-field">
        <label htmlFor="flyer-prompt">Describe the flyer</label>
        <textarea
          id="flyer-prompt"
          rows={3}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="e.g. A festive Diwali sale flyer for a restaurant, warm colors, '20% off this weekend'"
        />
      </div>
      <button type="button" className="primary" onClick={generate} disabled={generating || !enabled}>
        <Sparkles size={16} aria-hidden="true" /> {generating ? 'Generating…' : 'Generate flyer'}
      </button>
      {result && (
        <div style={{ marginTop: 16 }}>
          <img src={result.imageRef} alt={result.altText} style={{ maxWidth: '100%', borderRadius: 8, display: 'block', marginBottom: 8 }} />
          <a href={result.imageRef} target="_blank" rel="noreferrer" className="outline soc-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
            <ImageIcon size={15} aria-hidden="true" /> Open full size / download
          </a>
        </div>
      )}
    </section>
  );
}
