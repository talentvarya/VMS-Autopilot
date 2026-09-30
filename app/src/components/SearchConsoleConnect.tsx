'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Link2, RefreshCw, ShieldCheck, Unlink, XCircle } from 'lucide-react';
import { Title } from './dashboard/parts';
import type { RealClient } from './social/Composer';

/**
 * Phase G.19 - a real, separate section for real Google Search Console connections. Connecting
 * always happens on Google's own login page - clicking "Connect Search Console" here just
 * navigates the browser there; this app never sees a Google password.
 *
 * The one-time Google Cloud Console setup (registering an OAuth app) can never be automated by
 * this or any tool - every provider (Buffer included) requires the account owner to register
 * their own app on the provider's own developer console. That setup guide lives PERMANENTLY in
 * this card (not just told once in chat) so it never needs to be repeated or re-found.
 */

interface SearchAnalyticsTotals { clicks: number; impressions: number; ctr: number; position: number }
interface SearchAnalyticsQueryRow { query: string; clicks: number; impressions: number; ctr: number; position: number }

const SETUP_STEPS = [
  { title: 'Open Google Cloud Console', detail: 'Go to console.cloud.google.com and create a new project (or pick an existing one).' },
  { title: 'Enable the Search Console API', detail: '"APIs & Services" → "Library" → search "Google Search Console API" → Enable.' },
  { title: 'Set up the OAuth consent screen', detail: '"APIs & Services" → "OAuth consent screen" → choose "External" → fill in app name and support email → add scope: webmasters.readonly.' },
  { title: 'Create an OAuth client ID', detail: '"APIs & Services" → "Credentials" → "Create Credentials" → "OAuth client ID" → Application type: "Web application".' },
  { title: 'Add the redirect URI', detail: 'Under "Authorized redirect URIs", add exactly: https://vms-autopilot.vercel.app/api/integrations/search-console/callback' },
  { title: 'Copy the Client ID and Client Secret', detail: 'After creating, Google shows both once (and always under the credential\'s own page after). Copy both.' },
  { title: 'Add them to Vercel', detail: 'Project Settings → Environment Variables → add GOOGLE_SEARCH_CONSOLE_CLIENT_ID and GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET with those values → redeploy.' },
];

function SetupGuide() {
  const [open, setOpen] = useState(false);
  return (
    <section className="card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        <Title text="One-time Google setup (do this once, before connecting any client)" />
        {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </button>
      <p style={{ padding: '4px 0 12px', opacity: 0.7 }}>
        This step cannot be automated by any tool — Google requires the account owner to register their own app, exactly like Buffer did. Do it once here; every client afterwards connects with just a button click.
      </p>
      {open && (
        <ol style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {SETUP_STEPS.map((step, i) => (
            <li key={i}>
              <strong>{step.title}</strong>
              <div style={{ opacity: 0.75, fontSize: 13 }}>{step.detail}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function SearchConsoleConnect({ realClients, notify }: { realClients: RealClient[]; notify: (text: string) => void }) {
  const [clientId, setClientId] = useState(realClients[0]?.id ?? '');
  const [connected, setConnected] = useState<boolean | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);
  const [totals, setTotals] = useState<SearchAnalyticsTotals | null>(null);
  const [topQueries, setTopQueries] = useState<SearchAnalyticsQueryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const client = realClients.find((c) => c.id === clientId);

  const load = async (id: string) => {
    if (!id) return;
    setLoading(true);
    setTotals(null);
    setTopQueries(null);
    try {
      const statusRes = await fetch(`/api/integrations/search-console/status?workspaceId=${id}`);
      const statusBody = await statusRes.json();
      if (!statusRes.ok) { notify(statusBody.error || 'Could not check Search Console status'); return; }
      setConnected(statusBody.connected);
      setVerified(statusBody.verified ?? null);
      setSiteUrl(statusBody.siteUrl ?? null);
      setConnectedAt(statusBody.connectedAt ?? null);
      if (!statusBody.connected) return;

      const perfRes = await fetch(`/api/integrations/search-console/performance?workspaceId=${id}`);
      const perfBody = await perfRes.json();
      if (!perfRes.ok) { notify(perfBody.error || 'Could not load Search Console performance'); return; }
      setTotals(perfBody.totals ?? null);
      setTopQueries(perfBody.topQueries ?? null);
    } catch {
      notify('Could not reach Search Console — check your connection');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(clientId); }, [clientId]);

  const connect = () => {
    if (!clientId) { notify('Add a real client first (Clients tab)'); return; }
    window.location.href = `/api/integrations/search-console/authorize?workspaceId=${clientId}`;
  };

  const disconnect = async () => {
    if (!window.confirm(`Disconnect Search Console for ${client?.name ?? 'this client'}?`)) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/integrations/search-console/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: clientId }),
      });
      const body = await res.json();
      if (!res.ok) { notify(body.error || 'Could not disconnect'); return; }
      notify('Search Console disconnected');
      load(clientId);
    } catch {
      notify('Could not disconnect — check your connection');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="soc">
      <SetupGuide />

      <div className="seo-toolbar">
        <div className="seo-field">
          <label htmlFor="sc-client">Client</label>
          <select id="sc-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {realClients.length === 0 && <option value="">No clients yet</option>}
            {realClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="seo-actions">
          <button type="button" className="outline soc-btn" onClick={() => load(clientId)} disabled={loading || !clientId}>
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>
      <p className="seo-badge-sample">
        <ShieldCheck size={15} aria-hidden="true" /> Real: this connects a real Google Search Console account for the selected client, read-only — it can never change Search Console settings, submit a sitemap, or request indexing.
      </p>

      <section className="card">
        <Title text="Search Console Connection" />
        {realClients.length === 0 ? (
          <p className="seo-note">Add a real client first (Clients tab).</p>
        ) : connected === null ? (
          <p className="seo-note">{loading ? 'Checking…' : ''}</p>
        ) : connected ? (
          <>
            <p style={{ padding: '4px 0 4px' }}>
              Connected{connectedAt ? ` since ${new Date(connectedAt).toLocaleString()}` : ''} for <strong>{client?.name}</strong>.
            </p>
            <p style={{ padding: '0 0 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
              {verified === true && <><CheckCircle2 size={16} color="#16a34a" aria-hidden="true" /> Verified in Search Console: <code>{siteUrl}</code></>}
              {verified === false && <><XCircle size={16} color="#b45309" aria-hidden="true" /> Connected, but <code>{siteUrl}</code> is NOT yet verified in Search Console for this Google account.</>}
              {verified === null && <>Could not check verification right now — try Refresh.</>}
            </p>
            <button type="button" className="outline soc-btn" onClick={disconnect} disabled={disconnecting}>
              <Unlink size={15} aria-hidden="true" /> {disconnecting ? 'Disconnecting…' : 'Disconnect Search Console'}
            </button>
          </>
        ) : (
          <>
            <p style={{ padding: '4px 0 12px', opacity: 0.7 }}>
              Not connected yet for <strong>{client?.name}</strong>. Connecting opens Google's own sign-in page — you (or the client) log in there directly; this app never sees that password.
            </p>
            <button type="button" className="primary" onClick={connect}>
              <Link2 size={16} aria-hidden="true" /> Connect Search Console
            </button>
          </>
        )}
      </section>

      {connected && totals && (
        <section className="card">
          <Title text="Search performance (last 28 days)" />
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 24, fontWeight: 600 }}>{totals.clicks}</div>
              <div style={{ opacity: 0.7 }}>Clicks</div>
            </div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 600 }}>{totals.impressions}</div>
              <div style={{ opacity: 0.7 }}>Impressions</div>
            </div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 600 }}>{(totals.ctr * 100).toFixed(1)}%</div>
              <div style={{ opacity: 0.7 }}>CTR</div>
            </div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 600 }}>{totals.position.toFixed(1)}</div>
              <div style={{ opacity: 0.7 }}>Avg. position</div>
            </div>
          </div>
          {topQueries && topQueries.length > 0 && (
            <>
              <p style={{ fontWeight: 600, marginBottom: 6 }}>Top search queries</p>
              <ul style={{ paddingLeft: 18 }}>
                {topQueries.map((q, i) => (
                  <li key={i}>
                    <strong>{q.query}</strong> — {q.clicks} clicks, {q.impressions} impressions, avg. position {q.position.toFixed(1)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
