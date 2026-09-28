'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Download, FileWarning, Gauge, History, Printer, Play, ShieldCheck } from 'lucide-react';
import { decide, type Role } from '@/lib/permissions';
import { downloadText } from '@/lib/download';
import { reportFilename, reportToCsv } from '@/lib/seo/csv';
import { runAudit } from '@/lib/seo/engine';
import { FIXTURE_SITES } from '@/lib/seo/fixtures';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  type AuditResult,
  type Category,
  type Finding,
  type FixStatus,
  type RunStatus,
  type Severity,
} from '@/lib/seo/types';
import { Title } from './dashboard/parts';

/**
 * SEO / GEO Audit module (Phase 2) - runs on SAMPLE websites only.
 *
 * What each person can do comes from the same permission rules the database enforces
 * (src/lib/permissions): a Client can view, run audits and download reports but has no way to
 * apply a fix; only an Admin can record that a fix was applied. The page never contacts a
 * website - the engine reads built-in sample pages.
 */

const MAX_RUNS_PER_SITE_PER_DAY = 5; // mirrors the database limit

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
  pass: 'Passed',
};
const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info', 'pass'];

interface RunView {
  id: string;
  status: RunStatus;
  auditedAt: string;
  result: AuditResult | null;
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

const band = (score: number | null) =>
  score === null ? { label: 'Not measured', cls: 'none' } : score >= 80 ? { label: 'Good', cls: 'good' } : score >= 50 ? { label: 'Needs work', cls: 'ok' } : { label: 'Poor', cls: 'poor' };

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

export default function SeoAuditModule({ notify, initialRole = 'admin' }: { notify: (text: string) => void; initialRole?: Extract<Role, 'admin' | 'client'> }) {
  const [role, setRole] = useState<'admin' | 'client'>(initialRole);
  const [siteId, setSiteId] = useState(FIXTURE_SITES[0].id);
  const [runs, setRuns] = useState<Record<string, RunView[]>>(() =>
    Object.fromEntries(
      FIXTURE_SITES.map((s) => [
        s.id,
        [{ id: `${s.id}-initial`, status: 'completed' as const, auditedAt: s.snapshot.fetchedAt, result: runAudit(s.snapshot, { businessType: s.businessType }) }],
      ]),
    ),
  );
  const [fixes, setFixes] = useState<Record<string, Record<string, FixStatus>>>({});
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | Category>('all');
  const [showPassed, setShowPassed] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Where keyboard focus should go after the control that had it disappears (WCAG 2.4.3).
  const [focusAfter, setFocusAfter] = useState<{ code: string; target: 'cancel' | 'trigger' } | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    if (!focusAfter) return;
    document.getElementById(`seo-${focusAfter.target}-${focusAfter.code}`)?.focus();
    setFocusAfter(null);
  }, [focusAfter, confirming]);

  // The same rules the database enforces decide what this person sees and can do.
  const principal = { role, grants: [] };
  const canRun = decide(principal, 'seo_geo', 'create').effect === 'allow';
  const canApply = decide(principal, 'seo_geo', 'publish_execute').effect === 'allow';

  const site = FIXTURE_SITES.find((s) => s.id === siteId)!;
  const siteRuns = runs[siteId];
  const latestDone = siteRuns.find((r) => r.status === 'completed' && r.result);
  const running = siteRuns.some((r) => r.status === 'queued' || r.status === 'running');
  const runsToday = siteRuns.length - 1; // the first entry is the pre-loaded sample report
  const limitReached = runsToday >= MAX_RUNS_PER_SITE_PER_DAY;
  const result = latestDone?.result ?? null;
  const fixOf = (f: Finding): FixStatus => fixes[siteId]?.[f.code] ?? 'open';

  const startRun = () => {
    if (!canRun || running || limitReached) return;
    const id = `${siteId}-run-${siteRuns.length}`;
    const setStatus = (status: RunStatus, done?: AuditResult) =>
      setRuns((all) => ({
        ...all,
        [siteId]: all[siteId].map((r) => (r.id === id ? { ...r, status, result: done ?? r.result, auditedAt: done ? new Date().toISOString() : r.auditedAt } : r)),
      }));
    setRuns((all) => ({ ...all, [siteId]: [{ id, status: 'queued', auditedAt: new Date().toISOString(), result: null }, ...all[siteId]] }));
    notify('Audit queued');
    timers.current.push(window.setTimeout(() => setStatus('running'), 300));
    timers.current.push(
      window.setTimeout(() => {
        setStatus('completed', runAudit(site.snapshot, { businessType: site.businessType }));
        notify('Audit finished');
      }, 1100),
    );
  };

  const shown = useMemo(() => {
    if (!result) return [];
    return result.findings.filter(
      (f) =>
        (showPassed || f.severity !== 'pass' || severityFilter === 'pass') &&
        (severityFilter === 'all' || f.severity === severityFilter) &&
        (categoryFilter === 'all' || f.category === categoryFilter),
    );
  }, [result, severityFilter, categoryFilter, showPassed]);

  const exportCsv = () => {
    if (!result || !latestDone) return;
    const statuses = fixes[siteId] ?? {};
    downloadText(reportFilename(site.label, latestDone.auditedAt), reportToCsv(result, { siteLabel: site.label, origin: site.origin, auditedAt: latestDone.auditedAt }, statuses));
    notify('CSV report downloaded');
  };

  const setFix = (f: Finding, status: FixStatus) => {
    if (!canApply) return; // the database refuses this too
    setFixes((all) => ({ ...all, [siteId]: { ...all[siteId], [f.code]: status } }));
    setConfirming(null);
    setFocusAfter({ code: f.code, target: 'trigger' });
    notify(status === 'open' ? 'Fix record reopened and logged' : 'Fix recorded and logged');
  };

  const issues = result ? result.counts.critical + result.counts.high : 0;
  const overall = band(result?.overallScore ?? null);

  return (
    <div className="seo">
      <div className="seo-toolbar seo-noprint">
        <div className="seo-field">
          <label htmlFor="seo-site">Website</label>
          <select id="seo-site" value={siteId} onChange={e => { setSiteId(e.target.value); setConfirming(null); }}>
            {FIXTURE_SITES.map(s => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
        <div className="seo-actions">
          <button type="button" className="primary" onClick={startRun} aria-disabled={!canRun || running || limitReached ? true : undefined} aria-describedby="seo-run-help">
            <Play size={16} aria-hidden="true" /> {running ? 'Audit running…' : 'Run audit'}
          </button>
          <button type="button" className="outline seo-btn" onClick={exportCsv} disabled={!result}>
            <Download size={16} aria-hidden="true" /> Download CSV
          </button>
          <button type="button" className="outline seo-btn" onClick={() => window.print()} disabled={!result}>
            <Printer size={16} aria-hidden="true" /> Print / Save as PDF
          </button>
        </div>
      </div>
      <p className="seo-note seo-noprint" id="seo-run-help">
        {!canRun
          ? 'You do not have permission to run audits.'
          : limitReached
            ? `Daily limit reached for this website (${MAX_RUNS_PER_SITE_PER_DAY} audits per 24 hours).`
            : 'Running an audit only reads the website and builds a report. It never changes the website.'}
      </p>
      <p className="seo-badge-sample seo-noprint">
        <ShieldCheck size={15} aria-hidden="true" /> Sample data: these are invented websites. No real website or client account is contacted.
      </p>

      {process.env.NODE_ENV !== 'production' && (
        <fieldset className="seo-preview seo-noprint">
          <legend>Demo preview (development only)</legend>
          <label><input type="radio" name="seo-role" checked={role === 'admin'} onChange={() => setRole('admin')} /> View as Admin</label>
          <label><input type="radio" name="seo-role" checked={role === 'client'} onChange={() => setRole('client')} /> View as Client</label>
        </fieldset>
      )}

      <div className="seo-print-only">
        <p className="seo-print-title">SEO / GEO audit report: {site.label}</p>
        <p>{site.origin} · audited {latestDone ? fmt(latestDone.auditedAt) : ''}</p>
      </div>

      {!result ? (
        <div className="card"><p>No finished audit yet. {canRun ? 'Choose “Run audit”.' : ''}</p></div>
      ) : (
        <>
          <div className="stats">
            <Metric icon={<Gauge aria-hidden="true" />} tone="violet" label="Overall score" value={result.overallScore === null ? '–' : `${result.overallScore}/100`} sub={overall.label} />
            <Metric icon={<FileWarning aria-hidden="true" />} tone="blue" label="Critical + high issues" value={String(issues)} sub={`${result.counts.medium} medium, ${result.counts.low} low`} />
            <Metric icon={<CheckCircle2 aria-hidden="true" />} tone="green" label="Checks passed" value={String(result.counts.pass)} sub={`of ${result.findings.length - result.counts.info} checked`} />
            <Metric icon={<History aria-hidden="true" />} tone="teal" label="Last audited" value={fmt(latestDone!.auditedAt).split(',')[0]} sub={fmt(latestDone!.auditedAt).split(',').slice(1).join(',').trim()} />
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
                      <span
                        className="seo-bar"
                        role="img"
                        aria-label={score === null ? `${CATEGORY_LABELS[cat]}: not measured` : `${CATEGORY_LABELS[cat]}: ${b.label}`}
                      >
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
                {siteRuns.map(r => (
                  <li key={r.id}>
                    <span className={'seo-status ' + r.status}>{r.status === 'completed' ? 'Completed' : r.status === 'running' ? 'Running' : r.status === 'queued' ? 'Queued' : 'Failed'}</span>
                    <span>{fmt(r.auditedAt)}</span>
                    <b>
                      {r.result?.overallScore != null ? (
                        <>
                          <span className="sr-only">Score: </span>
                          {r.result.overallScore}
                        </>
                      ) : (
                        <>
                          <span className="sr-only">Score not available</span>
                          <span aria-hidden="true">–</span>
                        </>
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
            <p className="seo-count" aria-live="polite">{shown.length} finding{shown.length === 1 ? '' : 's'} shown for {site.label}</p>
            {!canApply && <p className="seo-note">Only your agency can apply fixes. You can view and download this report.</p>}

            {SEVERITY_ORDER.map(sev => {
              const group = shown.filter(f => f.severity === sev);
              if (!group.length) return null;
              return (
                <div key={sev} className="seo-group">
                  <h4>{SEVERITY_LABEL[sev]} <span>({group.length})</span></h4>
                  <ul className="seo-findings">
                    {group.map(f => {
                      const status = fixOf(f);
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
                              {status !== 'open' && <span className="seo-fixed"><CheckCircle2 size={14} aria-hidden="true" /> {status === 'applied' ? 'Fix applied' : 'Won’t fix'}</span>}
                              {canApply && confirming !== f.code && (
                                status === 'open' ? (
                                  <button type="button" id={`seo-trigger-${f.code}`} className="outline seo-btn" onClick={() => { setConfirming(f.code); setFocusAfter({ code: f.code, target: 'cancel' }); }} aria-label={`Mark as applied: ${f.title}`}>Mark as applied</button>
                                ) : (
                                  <button type="button" id={`seo-trigger-${f.code}`} className="outline seo-btn" onClick={() => setFix(f, 'open')} aria-label={`Reopen: ${f.title}`}>Reopen</button>
                                )
                              )}
                              {canApply && confirming === f.code && (
                                <span className="seo-confirm" role="group" aria-label={`Confirm applying: ${f.title}`}>
                                  Record that this fix was made? This is logged. It does not change the website.
                                  <button type="button" className="primary seo-btn" onClick={() => setFix(f, 'applied')}>Yes, record it</button>
                                  <button type="button" id={`seo-cancel-${f.code}`} className="outline seo-btn" onClick={() => { setConfirming(null); setFocusAfter({ code: f.code, target: 'trigger' }); }}>Cancel</button>
                                </span>
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
