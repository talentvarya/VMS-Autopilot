'use client';

import { useEffect, useState } from 'react';
import { Link2, RefreshCw, ShieldCheck, Unlink } from 'lucide-react';
import { BUFFER_SERVICE_LABELS } from '@/lib/integrations/buffer';
import { Title } from './dashboard/parts';
import type { RealClient } from './social/Composer';

/**
 * Phase G.11 - a real, separate page for real Buffer connections and their real insights.
 * Deliberately its own tab, not folded into the sandbox Social Publishing page: that page stays
 * 100% invented data, and this page is the one real (opt-in, per-client) place where an Admin
 * connects a client's actual Buffer account. Connecting always happens on Buffer's own login
 * page - clicking "Connect Buffer" here just navigates the browser there; this app never sees
 * a Buffer password.
 */

interface BufferChannel { id: string; name: string; displayName: string; service: string; avatar: string | null; isQueuePaused: boolean }
interface BufferMetric { type: string; value: number; unit: string }

const METRIC_LABELS: Record<string, string> = {
  postCount: 'Posts', reactions: 'Reactions', comments: 'Comments', impressions: 'Impressions',
  reach: 'Reach', engagementRate: 'Engagement rate', saves: 'Saves', clicks: 'Clicks',
};

export default function ConnectedAccounts({ realClients, notify }: { realClients: RealClient[]; notify: (text: string) => void }) {
  const [clientId, setClientId] = useState(realClients[0]?.id ?? '');
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);
  const [channels, setChannels] = useState<BufferChannel[] | null>(null);
  const [metrics, setMetrics] = useState<BufferMetric[] | null>(null);
  const [metricsUpdatedAt, setMetricsUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const client = realClients.find(c => c.id === clientId);

  const load = async (id: string) => {
    if (!id) return;
    setLoading(true);
    setChannels(null);
    setMetrics(null);
    try {
      const statusRes = await fetch(`/api/integrations/buffer/status?workspaceId=${id}`);
      const statusBody = await statusRes.json();
      if (!statusRes.ok) { notify(statusBody.error || 'Could not check Buffer status'); return; }
      setConnected(statusBody.connected);
      setConnectedAt(statusBody.connectedAt);
      if (!statusBody.connected) return;

      const insightsRes = await fetch(`/api/integrations/buffer/insights?workspaceId=${id}`);
      const insightsBody = await insightsRes.json();
      if (!insightsRes.ok) { notify(insightsBody.error || 'Could not load Buffer insights'); return; }
      setChannels(insightsBody.channels ?? []);
      setMetrics(insightsBody.metrics ?? []);
      setMetricsUpdatedAt(insightsBody.metricsUpdatedAt ?? null);
    } catch {
      notify('Could not reach Buffer — check your connection');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(clientId); }, [clientId]);

  const connect = () => {
    if (!clientId) { notify('Add a real client first (Clients tab)'); return; }
    window.location.href = `/api/integrations/buffer/authorize?workspaceId=${clientId}`;
  };

  const disconnect = async () => {
    if (!window.confirm(`Disconnect Buffer for ${client?.name ?? 'this client'}? Real insights will stop showing until reconnected.`)) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/integrations/buffer/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: clientId }),
      });
      const body = await res.json();
      if (!res.ok) { notify(body.error || 'Could not disconnect'); return; }
      notify('Buffer disconnected');
      load(clientId);
    } catch {
      notify('Could not disconnect — check your connection');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="soc">
      <div className="seo-toolbar">
        <div className="seo-field">
          <label htmlFor="ca-client">Client</label>
          <select id="ca-client" value={clientId} onChange={e => setClientId(e.target.value)}>
            {realClients.length === 0 && <option value="">No clients yet</option>}
            {realClients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="seo-actions">
          <button type="button" className="outline soc-btn" onClick={() => load(clientId)} disabled={loading || !clientId}>
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>
      <p className="seo-badge-sample">
        <ShieldCheck size={15} aria-hidden="true" /> Real: this page connects a real Buffer account for the selected client and shows their real insights. It never publishes anything — this app cannot post on your behalf.
      </p>

      <section className="card">
        <Title text="Buffer Connection" />
        {realClients.length === 0 ? (
          <p className="seo-note">Add a real client first (Clients tab).</p>
        ) : connected === null ? (
          <p className="seo-note">{loading ? 'Checking…' : ''}</p>
        ) : connected ? (
          <>
            <p style={{ padding: '4px 0 12px' }}>
              Connected{connectedAt ? ` since ${new Date(connectedAt).toLocaleString()}` : ''} for <strong>{client?.name}</strong>.
            </p>
            <button type="button" className="outline soc-btn" onClick={disconnect} disabled={disconnecting}>
              <Unlink size={15} aria-hidden="true" /> {disconnecting ? 'Disconnecting…' : 'Disconnect Buffer'}
            </button>
          </>
        ) : (
          <>
            <p style={{ padding: '4px 0 12px', opacity: 0.7 }}>
              Not connected yet for <strong>{client?.name}</strong>. Connecting opens Buffer's own sign-in page — you (or the client) log in there directly; this app never sees that password.
            </p>
            <button type="button" className="primary" onClick={connect}>
              <Link2 size={16} aria-hidden="true" /> Connect Buffer
            </button>
          </>
        )}
      </section>

      {connected && channels && (
        <section className="card">
          <Title text="Channels" />
          {channels.length === 0 ? (
            <p className="seo-note">No channels found on this Buffer account yet.</p>
          ) : (
            <ul style={{ paddingLeft: 18 }}>
              {channels.map(c => (
                <li key={c.id}>
                  <strong>{BUFFER_SERVICE_LABELS[c.service] ?? c.service}</strong> — {c.displayName} ({c.name}){c.isQueuePaused ? ' — paused' : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {connected && metrics && (
        <section className="card">
          <Title text="Insights (last 30 days)" />
          {metricsUpdatedAt && <p style={{ opacity: 0.7, marginBottom: 8 }}>Updated {new Date(metricsUpdatedAt).toLocaleString()}</p>}
          {metrics.length === 0 ? (
            <p className="seo-note">No metrics yet — Buffer needs published posts on this account to report insights.</p>
          ) : (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {metrics.map((m, i) => (
                <div key={i}>
                  <div style={{ fontSize: 24, fontWeight: 600 }}>{m.value}{m.unit === 'percentage' ? '%' : ''}</div>
                  <div style={{ opacity: 0.7 }}>{METRIC_LABELS[m.type] ?? m.type}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
