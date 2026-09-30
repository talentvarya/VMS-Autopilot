'use client';

import { useEffect, useState } from 'react';
import { CalendarRange, CheckCircle2, Clapperboard } from 'lucide-react';
import { Title } from '../dashboard/parts';
import type { RealClient } from './Composer';

/**
 * Phase G.10 - the rest of the Social Media Super Agent: content calendar generation and video
 * scripts, both real (persisted for the calendar, computed for the script), both free - neither
 * calls a paid AI provider. Caption text and flyer images are the paid pieces and already have
 * their own cards/toggles elsewhere.
 *
 * Phase G.14 - adds the approval list: every generated calendar slot starts 'pending' and needs
 * an explicit Approve here. The reminder cron (api/cron/calendar-approval-reminders) nudges
 * whoever needs to approve one - it never approves anything itself.
 */

interface CalendarSlot { plannedDate: string; theme: string }
interface VideoScript { hook: string; body: string; callToAction: string; shotList: string[] }
interface CalendarItem { id: string; planned_date: string; theme: string; approval_status: 'pending' | 'approved' }

export default function SocialSuperAgent({ realClients, notify }: { realClients: RealClient[]; notify: (text: string) => void }) {
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [days, setDays] = useState(7);
  const [generatingCalendar, setGeneratingCalendar] = useState(false);
  const [slots, setSlots] = useState<CalendarSlot[] | null>(null);

  const [scriptTopic, setScriptTopic] = useState('');
  const [network, setNetwork] = useState<'instagram' | 'tiktok' | 'youtube'>('instagram');
  const [writingScript, setWritingScript] = useState(false);
  const [script, setScript] = useState<VideoScript | null>(null);

  const [approvalClientId, setApprovalClientId] = useState(realClients[0]?.id ?? '');
  const [calendarItems, setCalendarItems] = useState<CalendarItem[] | null>(null);
  const [loadingItems, setLoadingItems] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const loadCalendarItems = async (clientId: string) => {
    if (!clientId) { setCalendarItems(null); return; }
    setLoadingItems(true);
    try {
      const res = await fetch(`/api/content-calendar?workspaceId=${clientId}`);
      const body = await res.json();
      if (!res.ok) { notify(body.error || 'Could not load the calendar'); return; }
      setCalendarItems(body.items ?? []);
    } catch {
      notify('Could not load the calendar — check your connection');
    } finally {
      setLoadingItems(false);
    }
  };

  useEffect(() => { loadCalendarItems(approvalClientId); }, [approvalClientId]);

  const approveItem = async (id: string) => {
    setApprovingId(id);
    try {
      const res = await fetch(`/api/content-calendar/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalStatus: 'approved' }),
      });
      const body = await res.json();
      if (!res.ok) { notify(body.error || 'Could not approve'); return; }
      setCalendarItems(prev => prev?.map(item => (item.id === id ? { ...item, approval_status: 'approved' } : item)) ?? null);
      notify('Approved');
    } catch {
      notify('Could not approve — check your connection');
    } finally {
      setApprovingId(null);
    }
  };

  const generateCalendar = async () => {
    if (realClients.length === 0) {
      notify('Add a real client first (Clients tab) - the calendar is saved against a client.');
      return;
    }
    if (!topic.trim()) {
      notify('Describe the business/topic first');
      return;
    }
    const typedClient = window.prompt(`Which client is this for? (${realClients.map(c => c.name).join(', ')})`)?.trim().toLowerCase();
    if (!typedClient) return;
    const client = realClients.find(c => c.name.toLowerCase() === typedClient);
    if (!client) {
      notify('No client matches that name');
      return;
    }

    setGeneratingCalendar(true);
    setSlots(null);
    try {
      const res = await fetch('/api/agents/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: 'generate_calendar',
          workspaceId: client.id,
          topic,
          audience: audience.trim() || undefined,
          startDate: new Date().toISOString().slice(0, 10),
          days,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not generate the calendar');
        return;
      }
      setSlots(body.output?.slots ?? []);
      notify(`${days}-day content calendar saved for ${client.name}`);
      if (client.id === approvalClientId) loadCalendarItems(approvalClientId);
    } catch {
      notify('Could not generate the calendar — check your connection');
    } finally {
      setGeneratingCalendar(false);
    }
  };

  const writeScript = async () => {
    if (!scriptTopic.trim()) {
      notify('Describe the video topic first');
      return;
    }
    setWritingScript(true);
    setScript(null);
    try {
      const res = await fetch('/api/agents/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'video_script', topic: scriptTopic, network }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not write the script');
        return;
      }
      setScript(body.output?.script ?? null);
      notify('Video script ready');
    } catch {
      notify('Could not write the script — check your connection');
    } finally {
      setWritingScript(false);
    }
  };

  return (
    <>
      <section className="card">
        <Title text="Content Calendar (AI)" />
        <p style={{ padding: '4px 0 12px', opacity: 0.7 }}>
          Describe the business/offer and how many days to plan - real dated theme slots are saved for the client, ready to turn into posts.
        </p>
        <div className="seo-field">
          <label htmlFor="cal-topic">Business / topic / offer</label>
          <input id="cal-topic" value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g. Weekend discount at a real estate agency" />
        </div>
        <div className="seo-field">
          <label htmlFor="cal-audience">Audience (optional)</label>
          <input id="cal-audience" value={audience} onChange={e => setAudience(e.target.value)} placeholder="e.g. First-time home buyers" />
        </div>
        <div className="seo-field">
          <label htmlFor="cal-days">Days</label>
          <input id="cal-days" type="number" min={1} max={30} value={days} onChange={e => setDays(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} />
        </div>
        <button type="button" className="primary" onClick={generateCalendar} disabled={generatingCalendar}>
          <CalendarRange size={16} aria-hidden="true" /> {generatingCalendar ? 'Generating…' : 'Generate content calendar'}
        </button>
        {slots && (
          <ul style={{ marginTop: 16, paddingLeft: 18 }}>
            {slots.map((s, i) => <li key={i}><strong>{s.plannedDate}</strong> — {s.theme}</li>)}
          </ul>
        )}
      </section>

      <section className="card">
        <Title text="Calendar Approvals" />
        <p style={{ padding: '4px 0 12px', opacity: 0.7 }}>
          Every generated slot starts pending. Approve it here before its planned date - a reminder is sent
          (in-app, 12:00–15:00 IST) starting 2 days before, until it's approved.
        </p>
        {realClients.length > 0 && (
          <div className="seo-field">
            <label htmlFor="approval-client">Client</label>
            <select id="approval-client" value={approvalClientId} onChange={e => setApprovalClientId(e.target.value)}>
              {realClients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        {loadingItems ? (
          <p className="seo-note">Loading…</p>
        ) : !calendarItems || calendarItems.length === 0 ? (
          <p className="seo-note">No calendar items yet for this client.</p>
        ) : (
          <ul style={{ paddingLeft: 0, listStyle: 'none' }}>
            {calendarItems.map(item => (
              <li key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border, #e5e7eb)' }}>
                <span style={{ flex: 1 }}>
                  <strong>{item.planned_date}</strong> — {item.theme}{' '}
                  {item.approval_status === 'approved' ? <em style={{ opacity: 0.7 }}>(approved)</em> : <em style={{ color: '#b45309' }}>(pending)</em>}
                </span>
                {item.approval_status === 'pending' && (
                  <button type="button" className="outline soc-btn" onClick={() => approveItem(item.id)} disabled={approvingId === item.id}>
                    <CheckCircle2 size={15} aria-hidden="true" /> {approvingId === item.id ? 'Approving…' : 'Approve'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <Title text="Video Script (AI)" />
        <p style={{ padding: '4px 0 12px', opacity: 0.7 }}>Describe the video topic - a hook, body, call-to-action and shot list come back. No video is rendered.</p>
        <div className="seo-field">
          <label htmlFor="script-topic">Video topic</label>
          <input id="script-topic" value={scriptTopic} onChange={e => setScriptTopic(e.target.value)} placeholder="e.g. 3 tips before renting your first office space" />
        </div>
        <div className="seo-field">
          <label htmlFor="script-network">Network</label>
          <select id="script-network" value={network} onChange={e => setNetwork(e.target.value as typeof network)}>
            <option value="instagram">Instagram Reels</option>
            <option value="tiktok">TikTok</option>
            <option value="youtube">YouTube Shorts</option>
          </select>
        </div>
        <button type="button" className="primary" onClick={writeScript} disabled={writingScript}>
          <Clapperboard size={16} aria-hidden="true" /> {writingScript ? 'Writing…' : 'Write a video script'}
        </button>
        {script && (
          <div style={{ marginTop: 16 }}>
            <p><strong>Hook:</strong> {script.hook}</p>
            <p><strong>Body:</strong> {script.body}</p>
            <p><strong>Call to action:</strong> {script.callToAction}</p>
            <p><strong>Shot list:</strong></p>
            <ul style={{ paddingLeft: 18 }}>{script.shotList.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
        )}
      </section>
    </>
  );
}
