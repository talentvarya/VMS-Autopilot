'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Download, FileWarning, Gauge, History, Printer, Play, ShieldCheck } from 'lucide-react';
import { downloadText } from '@/lib/download';
import { reportFilename, reportToCsv } from '@/lib/seo/csv';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  ENGINE_VERSION,
  type AuditResult,
  type Category,
  type FixStatus,
  type Severity,
} from '@/lib/seo/types';
import { Title } from './dashboard/parts';

/**
 * Phase G.16 - real SEO/GEO audits against a real client's own website (approved 2026-09-30).
 * Runs through /api/agents/seo (queue_audit with useRealWebsite: true), which resolves the
 * client's saved website_url, safely fetches it (lib/seo/live-fetch.ts - DNS-pinned, SSRF-
 * protected) and scores it with the same engine that already scored sample sites. Read-only:
 * it only reads the site and never changes it.
 */

export interface RealClient { id: string; name: string; websiteUrl: string | null }

interface SiteRow { id: string; origin: string; label: string; business_type: 'local' | 'online'; source: 'fixture' | 'live' }
interface RunRow {
  id: string; site_id: string; status: 'queued' | 'running' | 'completed' | 'failed';
  queued_at: string; started_at: string | null; finished_at: string | null;
  overall_score: number | null; overall_note: string | null;
  category_scores: Record<Category, number | null>; counts: Record<Severity, number>; error: string | null;
}
interface FindingRow {
  id: string; category: Category; severity: Severity; code: string; title: string;
  evidence: string; recommendation: string; fix_status: FixStatus; fix_note: string | null;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info', pass: 'Passed',
};
const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info', 'pass'];

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

const band = (score: number | null) =>
  score === null ? { label: 'Not measured', cls: 'none' } : score >= 80 ? { label: 'Good', cls: 'good' } : score >= 50 ? { label: 'Needs work', cls: 'ok' } : { label: 'Poor', cls: 'poor' };

export default function SeoAuditModule({ notify, realClients = [] }: { notify: (text: string) => void; realClients?: RealClient[] }) {
  const [clientId, setClientId] = useState(realClients[0]?.id ?? '');
  const client = realClients.find(c => c.id === clientId);

  const [sites, setSites] = useState<SiteRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | Category>('all');
  const [showPassed, setShowPassed] = useState(false);

  const load = async (id: string) => {
    if (!id) { setSites([]); setRuns([]); setFindings([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/seo-audits?workspaceId=${id}`);
      const body = await res.json();
      if (!res.ok) { notify(body.error || 'Could not load audits'); return; }
      setSites(body.sites ?? []);
      setRuns(body.runs ?? []);
      setFindings(body.findings ?? []);
    } catch {
      notify('Could not load audits — check your connection');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(clientId); }, [clientId]);

  const site = sites[0] ?? null;
  const latestRun = runs.find(r => r.status === 'completed') ?? null;
  const latestQueued = runs[0] ?? null;
  const isRunning = running || latestQueued?.status === 'queued' || latestQueued?.status === 'running';

  const runAudit = async () => {
    if (!client) { notify('Add a real client first (Clients tab)'); return; }
    if (!client.websiteUrl) { notify('Add this client\'s website first: Clients tab → "…" on their row → Website'); return; }
    setRunning(true);
    try {
      const res = await fetch('/api/agents/seo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'queue_audit', workspaceId: client.id, useRealWebsite: true }),
      });
      const body = await res.json();
      if (!res.ok) { notify(body.error || 'Could not run the audit'); return; }
      const status = body.run?.status;
      notify(status === 'completed' ? 'Audit finished' : status === 'failed' ? `Audit failed: ${body.run?.error ?? 'please try again'}` : 'Audit queued');
      await load(client.id);
    } catch {
      notify('Could not run the audit — check your connection');
    } finally {
      setRunning(false);
    }
  };

  const applyFix = async (finding: FindingRow) => {
    if (!client) return;
    try {
      const res = await fetch('/api/agents/seo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'propose_fix', workspaceId: client.id, findingId: finding.id }),
      });
      const body = await res.json();
      if (!res.ok) { notify(body.error || 'Could not record the fix'); return; }
      setFindings(prev => prev.map(f => (f.id === finding.id ? { ...f, fix_status: 'applied' } : f)));
      notify('Fix recorded (this does not change the website - it just logs that you made the change yourself)');
    } catch {
      notify('Could not record the fix — check your connection');
    }
  };

  const shown = useMemo(
    () => findings.filter(f =>
      (showPassed || f.severity !== 'pass' || severityFilter === 'pass') &&
      (severityFilter === 'all' || f.severity === severityFilter) &&
      (categoryFilter === 'all' || f.category === categoryFilter),
    ),
    [findings, severityFilter, categoryFilter, showPassed],
  );

  const asAuditResult = (): AuditResult | null => {
    if (!latestRun) return null;
    return {
      engineVersion: ENGINE_VERSION,
      overallScore: latestRun.overall_score,
      overallNote: latestRun.overall_note,
      categoryScores: latestRun.category_scores,
      counts: latestRun.counts,
      findings: findings.map(f => ({ category: f.category, severity: f.severity, code: f.code, title: f.title, evidence: f.evidence, recommendation: f.recommendation })),
    };
  };

  const exportCsv = () => {
    const result = asAuditResult();
    if (!result || !latestRun || !site) return;
    const fixStatus: Record<string, FixStatus> = Object.fromEntries(findings.filter(f => f.fix_status !== 'open').map(f => [f.code, f.fix_status]));
    downloadText(
      reportFilename(site.label, latestRun.finished_at ?? latestRun.queued_at),
      reportToCsv(result, { siteLabel: site.label, origin: site.origin, auditedAt: latestRun.finished_at ?? latestRun.queued_at }, fixStatus),
    );
    notify('CSV report downloaded');
  };

  const result = asAuditResult();
  const issues = result ? result.counts.critical + result.counts.high : 0;
  const overall = band(result?.overallScore ?? null);

  return (
    <div className="seo">
      <div className="seo-toolbar seo-noprint">
        <div className="seo-field">
          <label htmlFor="seo-client">Client</label>
          <select id="seo-client" value={clientId} onChange={e => setClientId(e.target.value)}>
            {realClients.length === 0 && <option value="">No clients yet</option>}
            {realClients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="seo-actions">
          <button type="button" className="primary" onClick={runAudit} aria-disabled={isRunning || !client}>
            <Play size={16} aria-hidden="true" /> {isRunning ? 'Audit running…' : 'Run audit'}
          </button>
          <button type="button" className="outline seo-btn" onClick={exportCsv} disabled={!result}>
            <Download size={16} aria-hidden="true" /> Download CSV
          </button>
          <button type="button" className="outline seo-btn" onClick={() => window.print()} disabled={!result}>
            <Printer size={16} aria-hidden="true" /> Print / Save as PDF
          </button>
        </div>
      </div>
      <p className="seo-note seo-noprint">
        {!client
          ? 'Add a real client first (Clients tab).'
          : !client.websiteUrl
            ? 'This client has no website saved yet - add one from the Clients tab ("…" on their row → Website) before running an audit.'
            : 'Running an audit only reads the website (homepage, robots.txt, sitemap.xml, llms.txt) and builds a report. It never changes the website.'}
      </p>
      <p className="seo-badge-sample seo-noprint">
        <ShieldCheck size={15} aria-hidden="true" /> Real: this reads the client's actual website over the internet, read-only. No login, no writes, nothing is ever posted.
      </p>

      <div className="seo-print-only">
        <p className="seo-print-title">SEO / GEO audit report: {site?.label ?? client?.name ?? ''}</p>
        <p>{site?.origin ?? ''} · audited {latestRun ? fmt(latestRun.finished_at ?? latestRun.queued_at) : ''}</p>
      </div>

      {loading ? (
        <div className="card"><p>Loading…</p></div>
      ) : !result ? (
        <div className="card"><p>No finished audit yet. {client?.websiteUrl ? 'Choose "Run audit".' : ''}</p></div>
      ) : (
        <>
          <div className="stats">
            <Metric icon={<Gauge aria-hidden="true" />} tone="violet" label="Overall score" value={result.overallScore === null ? '–' : `${result.overallScore}/100`} sub={overall.label} />
            <Metric icon={<FileWarning aria-hidden="true" />} tone="blue" label="Critical + high issues" value={String(issues)} sub={`${result.counts.medium} medium, ${result.counts.low} low`} />
            <Metric icon={<CheckCircle2 aria-hidden="true" />} tone="green" label="Checks passed" value={String(result.counts.pass)} sub={`of ${result.findings.length - result.counts.info} checked`} />
            <Metric icon={<History aria-hidden="true" />} tone="teal" label="Last audited" value={latestRun ? fmt(latestRun.finished_at ?? latestRun.queued_at).split(',')[0] : '–'} sub={latestRun ? fmt(latestRun.finished_at ?? latestRun.queued_at).split(',').slice(1).join(',').trim() : ''} />
          </div>
          {result.overallNote && (
            <p className="seo-alert" role="note">
              <FileWarning size={16} aria-hidden="true" /> {result.overallNote}
            </p>
          )}

          <div className="two-col">
            <section className="card">
              <Title text="Scores by area" />
              <ul className="seo-cats">
                {CATEGORIES.map(cat => {
                  const score = result.categoryScores[cat];
                  const b = band(score);
                  return (
                    <li key={cat} className="seo-cat">
                      <span className="seo-cat-name">{CATEGORY_LABELS[cat]}</span>
                      <span className="seo-bar" role="img" aria-label={score === null ? `${CATEGORY_LABELS[cat]}: not measured` : `${CATEGORY_LABELS[cat]}: ${b.label}`}>
                        <i className={'seo-fill ' + b.cls} style={{ width: `${score ?? 0}%` }} />
                      </span>
                      <span className="seo-cat-score">{score === null ? 'Not measured' : score}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="card seo-noprint">
              <Title text="Audit history" />
              <ul className="seo-history">
                {runs.map(r => (
                  <li key={r.id}>
                    <span className={'seo-status ' + r.status}>{r.status === 'completed' ? 'Completed' : r.status === 'running' ? 'Running' : r.status === 'queued' ? 'Queued' : 'Failed'}</span>
                    <span>{fmt(r.finished_at ?? r.queued_at)}</span>
                    <b>
                      {r.overall_score != null ? (
                        <><span className="sr-only">Score: </span>{r.overall_score}</>
                      ) : (
                        <><span className="sr-only">Score not available</span><span aria-hidden="true">–</span></>
                      )}
                    </b>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className="card">
            <Title text="Findings" />
            <div className="seo-filters seo-noprint">
              <div className="seo-field">
                <label htmlFor="seo-sev">Severity</label>
                <select id="seo-sev" value={severityFilter} onChange={e => setSeverityFilter(e.target.value as 'all' | Severity)}>
                  <option value="all">All</option>
                  {SEVERITY_ORDER.map(s => (
                    <option key={s} value={s}>{SEVERITY_LABEL[s]} ({result.counts[s]})</option>
                  ))}
                </select>
              </div>
              <div className="seo-field">
                <label htmlFor="seo-cat">Area</label>
                <select id="seo-cat" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value as 'all' | Category)}>
                  <option value="all">All areas</option>
                  {CATEGORIES.map(c => (
                    <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
              </div>
              <label className="seo-check">
                <input type="checkbox" checked={showPassed || severityFilter === 'pass'} disabled={severityFilter === 'pass'} onChange={e => setShowPassed(e.target.checked)} /> Show passed checks
              </label>
            </div>
            <p className="seo-count" aria-live="polite">{shown.length} finding{shown.length === 1 ? '' : 's'} shown for {site?.label ?? client?.name}</p>

            {SEVERITY_ORDER.map(sev => {
              const group = shown.filter(f => f.severity === sev);
              const matching = findings.filter(f => f.severity === sev);
              if (!group.length) return null;
              return (
                <div key={sev} className="seo-group">
                  <h4>{SEVERITY_LABEL[sev]} <span>({group.length})</span></h4>
                  <ul className="seo-findings">
                    {group.map(f => {
                      const original = matching.find(m => m.code === f.code) ?? f;
                      const actionable = f.severity !== 'pass' && f.severity !== 'info';
                      return (
                        <li key={f.code} className="seo-finding">
                          <div className="seo-finding-head">
                            <span className={'seo-sev ' + f.severity}>{SEVERITY_LABEL[f.severity]}</span>
                            <strong>{f.title}</strong>
                            <span className="seo-area">{CATEGORY_LABELS[f.category]}</span>
                          </div>
                          {f.evidence && <p className="seo-evidence"><b>What we found:</b> {f.evidence}</p>}
                          {f.recommendation && <p className="seo-reco"><b>What to do:</b> {f.recommendation}</p>}
                          {actionable && (
                            <div className="seo-fix seo-noprint">
                              {original.fix_status === 'applied' ? (
                                <span className="seo-fixed"><CheckCircle2 size={14} aria-hidden="true" /> Fix applied</span>
                              ) : (
                                <button type="button" className="outline seo-btn" onClick={() => applyFix(original)} aria-label={`Mark as applied: ${f.title}`}>Mark as applied</button>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}

function Metric({ icon, tone, label, value, sub }: { icon: ReactNode; tone: string; label: string; value: string; sub: string }) {
  return (
    <div className="stat">
      <div className={'stat-icon ' + tone}>{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <p className="seo-sub">{sub}</p>
      </div>
    </div>
  );
}
