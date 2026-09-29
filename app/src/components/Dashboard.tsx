'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  Menu,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import SeoAuditModule from './SeoAuditModule';
import SocialModule from './SocialModule';
import { Approval, SimpleTable, Stat, Timeline, Title } from './dashboard/parts';
import { channelNames, nav, workspaceOptions, type ClientRow } from './dashboard/data';
import { useLazyList } from './dashboard/hooks';
import { useRouter } from 'next/navigation';
import { createClient as createBrowserSupabaseClient } from '@/lib/supabase/client';

type WorkspaceApiRow = { id: string; name: string; industry: string | null; kind: string; created_at: string };
type WorkspaceRef = { name: string } | null;
type ApprovalApiRow = {
  id: string;
  workspace_id: string;
  module: string;
  action: string;
  title: string;
  status: string;
  created_at: string;
  workspaces: WorkspaceRef;
};
type CampaignRow = {
  id: string;
  platform: string;
  objective: string;
  name: string;
  status: string;
  budget_amount: number | null;
  budget_period: string | null;
  created_at: string;
  workspaces: WorkspaceRef;
};
type LeadRow = {
  id: string;
  source: string;
  name: string | null;
  contact: string | null;
  status: string;
  created_at: string;
  workspaces: WorkspaceRef;
};
type WebsiteProjectRow = {
  id: string;
  provider: string;
  title: string;
  status: string;
  created_at: string;
  workspaces: WorkspaceRef;
};
type HealthIncidentRow = {
  id: string;
  check_type: string;
  opened_at: string;
  closed_at: string | null;
  auto_repair_attempted: boolean;
  workspaces: WorkspaceRef;
};
type HealthCheckRow = {
  id: string;
  check_type: string;
  status: string;
  checked_at: string;
  workspaces: WorkspaceRef;
};

function toClientRow(w: WorkspaceApiRow): ClientRow {
  return {
    id: w.id,
    name: w.name,
    type: w.industry || 'Unspecified',
    initial: w.name.charAt(0).toUpperCase() || '?',
    score: 0,
    ads: 'Paused',
    access: 'Limited',
    health: 'Needs Attention',
    channels: [],
  };
}

// "2 hours ago" - relative time for real timestamps in place of the old fixed mock text.
function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.floor(hours / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}

const approvalKind = (module: string) =>
  module === 'paid_ads' ? 'ads' : module === 'social' ? 'post' : 'domain';

const DEFAULT_TITLE = 'VMS Autopilot — AI-Powered Marketing Automation Platform';

/**
 * The approved VMS Autopilot dashboard, ported from interface/src/App.tsx.
 * Markup, class names and styles are unchanged. Additions are invisible on desktop:
 * accessibility labels/roles, keyboard handling, and a slide-in navigation drawer that
 * only appears below 1100px wide.
 */
export default function Dashboard() {
  const router = useRouter();
  const [active, setActive] = useState('Overview');
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState('Acme Marketing');
  const [workspaces, setWorkspaces] = useState(false);
  const [clientRows, setClientRows] = useState<ClientRow[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalApiRow[]>([]);
  const [approvalsLoaded, setApprovalsLoaded] = useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [navAnnouncement, setNavAnnouncement] = useState('');
  const [navOpen, setNavOpen] = useState(false);

  const toastTimer = useRef<number | undefined>(undefined);
  const announceCount = useRef(0);
  const firstRender = useRef(true);
  const returnFocus = useRef<'toggle' | 'main' | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceWrapRef = useRef<HTMLDivElement>(null);

  // The toast stays while the pointer or keyboard focus is on it (WCAG 2.2.1), and screen
  // readers hear every message - a trailing invisible character makes a repeat of the same
  // text count as a change.
  const startToastTimer = () => {
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 5000);
  };
  const pauseToastTimer = () => window.clearTimeout(toastTimer.current);
  const notify = (text: string) => {
    announceCount.current += 1;
    setAnnouncement(text + (announceCount.current % 2 ? '' : '​'));
    setToast(text);
    startToastTimer();
  };
  const dismissToast = () => {
    pauseToastTimer();
    setToast('');
    mainRef.current?.focus();
  };
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // Tell screen-reader users (and the browser tab) which page they are on.
  useEffect(() => {
    const name = active === 'Overview' ? 'Agency Overview' : active;
    document.title = active === 'Overview' ? DEFAULT_TITLE : name + ' · VMS Autopilot';
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setNavAnnouncement(name + ' page');
  }, [active]);

  // Real data from Supabase (app/src/app/api/workspaces/route.ts), scoped by RLS to this
  // signed-in user's own agency. Fetched once on mount; the middleware already guarantees
  // an authenticated session before this component ever renders.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/workspaces');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          notify(body.error || 'Could not load clients');
          return;
        }
        setClientRows((body.workspaces as WorkspaceApiRow[]).map(toClientRow));
      } catch {
        if (!cancelled) notify('Could not load clients — check your connection');
      } finally {
        if (!cancelled) setClientsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const addClient = async () => {
    const name = window.prompt('New client name?')?.trim();
    if (!name) return;
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not create client');
        return;
      }
      setClientRows(rows => [...rows, toClientRow(body.workspace as WorkspaceApiRow)]);
      notify(name + ' workspace created');
    } catch {
      notify('Could not create client — check your connection');
    }
  };

  // Real approval queue (app/src/app/api/approval-requests/route.ts). A fresh account has
  // no rows here yet - nothing has gone through a "needs approval" action yet - which is
  // correct, not a bug.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/approval-requests');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          notify(body.error || 'Could not load approvals');
          return;
        }
        setApprovals((body.approvals as ApprovalApiRow[]) ?? []);
      } catch {
        if (!cancelled) notify('Could not load approvals — check your connection');
      } finally {
        if (!cancelled) setApprovalsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Real signed-in identity for the Settings tab.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createBrowserSupabaseClient();
      const { data } = await supabase.auth.getUser();
      if (!cancelled) setUserEmail(data.user?.email ?? null);
    })();
    return () => { cancelled = true; };
  }, []);

  const signOut = async () => {
    const supabase = createBrowserSupabaseClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const decideApproval = async (id: string, status: 'approved' | 'rejected') => {
    setDecidingApprovalId(id);
    try {
      const res = await fetch('/api/approval-requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not update approval');
        return;
      }
      setApprovals(rows => rows.filter(row => row.id !== id));
      notify(status === 'approved' ? 'Approval completed and logged' : 'Request rejected');
    } catch {
      notify('Could not update approval — check your connection');
    } finally {
      setDecidingApprovalId(null);
    }
  };

  // Real numbers for the Overview stat cards + activity feed (app/src/app/api/overview-stats).
  const [overviewStats, setOverviewStats] = useState<{
    scheduledPosts: number;
    leadsThisMonth: number;
    healthScore: number | null;
    recentActivity: { id: number; at: string; action: string; target_type: string | null; workspaces: WorkspaceRef }[];
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/overview-stats');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          notify(body.error || 'Could not load overview stats');
          return;
        }
        setOverviewStats(body);
      } catch {
        if (!cancelled) notify('Could not load overview stats — check your connection');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [campaigns, campaignsLoaded] = useLazyList<CampaignRow>(active, 'Paid Ads', '/api/ad-campaigns', notify, 'campaigns');
  const [leads, leadsLoaded] = useLazyList<LeadRow>(active, 'Leads & CRM', '/api/leads', notify, 'leads');
  const [websiteProjects, websiteProjectsLoaded] = useLazyList<WebsiteProjectRow>(active, 'Domains', '/api/website-projects', notify, 'domain projects');

  // AI Monitor needs two lists (open incidents + recent checks) from one endpoint, so it
  // can't use the single-list useLazyList hook.
  const [healthIncidents, setHealthIncidents] = useState<HealthIncidentRow[]>([]);
  const [healthChecks, setHealthChecks] = useState<HealthCheckRow[]>([]);
  const [healthLoaded, setHealthLoaded] = useState(false);
  useEffect(() => {
    if (active !== 'AI Monitor' || healthLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/health');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          notify(body.error || 'Could not load health monitor');
          return;
        }
        setHealthIncidents((body.incidents as HealthIncidentRow[]) ?? []);
        setHealthChecks((body.checks as HealthCheckRow[]) ?? []);
      } catch {
        if (!cancelled) notify('Could not load health monitor — check your connection');
      } finally {
        if (!cancelled) setHealthLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [active, healthLoaded]);

  // --- Mobile navigation drawer (only visible below 1100px) ---------------------------
  const closeNav = useCallback(() => {
    returnFocus.current = 'toggle';
    setNavOpen(false);
  }, []);

  // Focus can only move back once the page behind the drawer is no longer inert.
  useEffect(() => {
    if (navOpen || !returnFocus.current) return;
    (returnFocus.current === 'toggle' ? navToggleRef.current : mainRef.current)?.focus();
    returnFocus.current = null;
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeNav();
    };
    document.addEventListener('keydown', onKey);
    sidebarRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen, closeNav]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const wide = window.matchMedia('(min-width: 1100px)');
    const onChange = () => {
      if (wide.matches) setNavOpen(false);
    };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, []);

  const selectModule = (label: string) => {
    setActive(label);
    if (navOpen) {
      returnFocus.current = 'main';
      setNavOpen(false);
    }
  };

  // --- Workspace menu: Escape and outside click close it ------------------------------
  useEffect(() => {
    if (!workspaces) return;
    const onPointer = (event: MouseEvent) => {
      if (!workspaceWrapRef.current?.contains(event.target as Node)) setWorkspaces(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [workspaces]);

  const unread = 3;

  // Shared between the Overview preview and the standalone Clients page (active === 'Clients')
  // so both read the same live clientRows state instead of drifting apart.
  const clientWorkspacesCard = (
    <section className="card">
      <Title
        text="Client Workspaces"
        right={
          active === 'Overview' ? (
            <button type="button" className="link" onClick={() => {
                setActive('Clients');
                mainRef.current?.focus();
              }}>
              View all clients <ArrowUpRight size={15} aria-hidden="true" />
            </button>
          ) : undefined
        }
      />
      <div className="table-scroll" role="region" aria-label="Client workspaces table" tabIndex={0}>
        <div className="table-grid" role="table" aria-label="Client workspaces">
          <div className="table-head" role="row">
            <span role="columnheader">Client</span>
            <span role="columnheader">Channels</span>
            <span role="columnheader">SEO/GEO Score</span>
            <span role="columnheader">Ads Status</span>
            <span role="columnheader">Permission</span>
            <span role="columnheader">Health</span>
            <span aria-hidden="true" />
          </div>
          {clientsLoaded && clientRows.length === 0 && (
            <div className="client-row" role="row">
              <span role="cell">No clients yet — use &quot;Add client&quot; to create your first one.</span>
            </div>
          )}
          {clientRows.map(client => (
            <div className="client-row" key={client.id} role="row">
              <div className="client-name" role="cell">
                <b className={'client-avatar ' + client.initial.toLowerCase()} aria-hidden="true">
                  {client.initial}
                </b>
                <div>
                  <strong>{client.name}</strong>
                  <small>{client.type}</small>
                </div>
              </div>
              <div className="channels" role="cell">
                {client.channels.map(item => (
                  <span
                    className={'channel ' + item}
                    key={item}
                    role="img"
                    aria-label={channelNames[item] ?? item}
                  >
                    {item}
                  </span>
                ))}
              </div>
              <div className="score" role="cell" aria-label={`SEO/GEO score ${client.score}`}>
                {client.score}
              </div>
              <div className={'status ' + client.ads.toLowerCase()} role="cell">
                <i aria-hidden="true" />
                {client.ads}
              </div>
              <span
                className={'pill ' + (client.access === 'Full Access' ? 'full' : 'limited')}
                role="cell"
              >
                {client.access}
              </span>
              <div
                className={'status ' + (client.health === 'Healthy' ? 'healthy' : 'attention')}
                role="cell"
              >
                <i aria-hidden="true" />
                {client.health}
              </div>
              <MoreHorizontal size={17} className="more" aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );

  return (
    <>
      <a className="skip-link" href="#main-content" inert={navOpen}>
        Skip to main content
      </a>
      <div className={navOpen ? 'shell nav-open' : 'shell'}>
        <aside className="sidebar" id="app-sidebar" ref={sidebarRef}>
          <button type="button" className="sidebar-close" aria-label="Close navigation menu" onClick={closeNav}>
            <X size={20} />
          </button>
          <div className="brand">
            <span className="logo" aria-hidden="true">
              V
            </span>
            <div>
              <strong>VMS Autopilot</strong>
              <small>
                AI-Powered Marketing
                <br />
                Automation Platform
              </small>
            </div>
          </div>
          <nav aria-label="Main navigation">
            {nav.map(([label, Icon]) => (
              <button
                type="button"
                key={label}
                className={active === label ? 'nav-item active' : 'nav-item'}
                aria-current={active === label ? 'page' : undefined}
                onClick={() => selectModule(label)}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="side-footer">
            <div aria-hidden="true"></div>Smarter marketing.
            <br />
            Happier clients.
          </div>
        </aside>
        <div className="scrim" aria-hidden="true" onClick={closeNav} />
        <main className="main" id="main-content" tabIndex={-1} ref={mainRef} inert={navOpen}>
          <header className="topbar">
            <div>
              <button
                type="button"
                className="menu-toggle"
                ref={navToggleRef}
                aria-label="VMS Autopilot, open navigation menu"
                aria-controls="app-sidebar"
                aria-expanded={navOpen}
                onClick={() => setNavOpen(true)}
              >
                <Menu size={20} aria-hidden="true" /> VMS Autopilot
              </button>
              <div className="mobile-brand" aria-hidden="true">
                <Menu size={18} /> VMS Autopilot
              </div>
              <h1>Good morning, Admin</h1>
              <p>Here’s what’s happening with your agency today.</p>
            </div>
            <div className="actions">
              <div
                className="workspace-wrap"
                ref={workspaceWrapRef}
                onBlur={event => {
                  const next = event.relatedTarget as Node | null;
                  // Ignore a null target: Safari does not focus buttons on click.
                  if (workspaces && next && !event.currentTarget.contains(next)) setWorkspaces(false);
                }}
                onKeyDown={event => {
                  if (event.key === 'Escape' && workspaces) {
                    setWorkspaces(false);
                    workspaceButtonRef.current?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  className="workspace"
                  ref={workspaceButtonRef}
                  aria-expanded={workspaces}
                  aria-controls="workspace-menu"
                  onClick={() => setWorkspaces(!workspaces)}
                >
                  <ShieldCheck size={17} aria-hidden="true" />
                  {workspace}
                  <ChevronDown size={15} aria-hidden="true" />
                </button>
                {workspaces && (
                  <div className="workspace-menu" id="workspace-menu" role="group" aria-label="Choose workspace">
                    {workspaceOptions.map(item => (
                      <button
                        type="button"
                        key={item}
                        aria-current={item === workspace ? 'true' : undefined}
                        onClick={() => {
                          setWorkspace(item);
                          setWorkspaces(false);
                          workspaceButtonRef.current?.focus();
                        }}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button type="button" className="primary" onClick={addClient}>
                <Plus size={16} aria-hidden="true" /> Add client
              </button>
              <button type="button" className="bell" aria-label={`Notifications, ${unread} unread`}>
                <Bell size={20} aria-hidden="true" />
                <i aria-hidden="true">{unread}</i>
              </button>
              <div className="avatar" role="img" aria-label="Admin, online">
                A<b aria-hidden="true" />
              </div>
            </div>
          </header>
          <section className="content" aria-labelledby="page-heading">
            <div className="heading">
              <h2 id="page-heading">{active === 'Overview' ? 'Agency Overview' : active}</h2>
              <button type="button" className="date">
                <CalendarDays size={16} aria-hidden="true" /> Apr 1, 2025 – Apr 30, 2025{' '}
                <ChevronDown size={15} aria-hidden="true" />
              </button>
            </div>
            {active === 'SEO / GEO Audit' ? (
              <SeoAuditModule notify={notify} />
            ) : active === 'Social Publishing' ? (
              <SocialModule notify={notify} />
            ) : active === 'Clients' ? (
              clientWorkspacesCard
            ) : active === 'Paid Ads' ? (
              <section className="card">
                <Title text="Ad Campaigns" />
                <SimpleTable
                  label="Ad campaigns"
                  loaded={campaignsLoaded}
                  emptyMessage="No ad campaigns yet."
                  rows={campaigns}
                  rowKey={row => row.id}
                  columns={[
                    { header: 'Client', render: row => row.workspaces?.name ?? '—' },
                    { header: 'Campaign', render: row => row.name },
                    { header: 'Platform', render: row => row.platform },
                    { header: 'Status', render: row => row.status },
                    {
                      header: 'Budget',
                      render: row =>
                        row.budget_amount != null ? `${row.budget_amount} / ${row.budget_period ?? 'total'}` : '—',
                    },
                    { header: 'Created', render: row => timeAgo(row.created_at) },
                  ]}
                />
              </section>
            ) : active === 'Leads & CRM' ? (
              <section className="card">
                <Title text="Leads" />
                <SimpleTable
                  label="Leads"
                  loaded={leadsLoaded}
                  emptyMessage="No leads yet."
                  rows={leads}
                  rowKey={row => row.id}
                  columns={[
                    { header: 'Client', render: row => row.workspaces?.name ?? '—' },
                    { header: 'Name', render: row => row.name ?? 'Unnamed lead' },
                    { header: 'Contact', render: row => row.contact ?? '—' },
                    { header: 'Source', render: row => row.source },
                    { header: 'Status', render: row => row.status },
                    { header: 'Created', render: row => timeAgo(row.created_at) },
                  ]}
                />
              </section>
            ) : active === 'Domains' ? (
              <section className="card">
                <Title text="Website Projects" />
                <SimpleTable
                  label="Website projects"
                  loaded={websiteProjectsLoaded}
                  emptyMessage="No website projects yet."
                  rows={websiteProjects}
                  rowKey={row => row.id}
                  columns={[
                    { header: 'Client', render: row => row.workspaces?.name ?? '—' },
                    { header: 'Title', render: row => row.title },
                    { header: 'Provider', render: row => row.provider },
                    { header: 'Status', render: row => row.status },
                    { header: 'Created', render: row => timeAgo(row.created_at) },
                  ]}
                />
              </section>
            ) : active === 'AI Monitor' ? (
              <>
                <section className="card">
                  <Title text="Open Incidents" />
                  <SimpleTable
                    label="Open incidents"
                    loaded={healthLoaded}
                    emptyMessage="No open incidents — everything is healthy."
                    rows={healthIncidents}
                    rowKey={row => row.id}
                    columns={[
                      { header: 'Client', render: row => row.workspaces?.name ?? '—' },
                      { header: 'Check', render: row => row.check_type },
                      { header: 'Opened', render: row => timeAgo(row.opened_at) },
                      { header: 'Auto-repair tried', render: row => (row.auto_repair_attempted ? 'Yes' : 'No') },
                    ]}
                  />
                </section>
                <section className="card">
                  <Title text="Recent Checks" />
                  <SimpleTable
                    label="Recent health checks"
                    loaded={healthLoaded}
                    emptyMessage="No health checks have run yet."
                    rows={healthChecks}
                    rowKey={row => row.id}
                    columns={[
                      { header: 'Client', render: row => row.workspaces?.name ?? '—' },
                      { header: 'Check', render: row => row.check_type },
                      { header: 'Result', render: row => row.status },
                      { header: 'Checked', render: row => timeAgo(row.checked_at) },
                    ]}
                  />
                </section>
              </>
            ) : active === 'Reports' ? (
              <div className="stats">
                <Stat icon={<Users aria-hidden="true" />} tone="violet" label="Clients" value={String(clientRows.length)} change="" />
                <Stat
                  icon={<Check aria-hidden="true" />}
                  tone="green"
                  label="Pending Approvals"
                  value={String(approvals.length)}
                  change=""
                />
              </div>
            ) : active === 'Settings' ? (
              <section className="card">
                <Title text="Account" />
                <p style={{ padding: '4px 0 16px', opacity: 0.8 }}>
                  Signed in as <strong>{userEmail ?? '…'}</strong>
                </p>
                <button type="button" className="outline" onClick={signOut}>
                  Sign out
                </button>
              </section>
            ) : active !== 'Overview' ? (
              <div className="module">
                <div className="module-icon" aria-hidden="true">
                  <Sparkles size={28} />
                </div>
                <div>
                  <h3>{active}</h3>
                  <p>
                    This module is ready for the next implementation phase. Admin
                    permissions control client access here.
                  </p>
                </div>
                <button type="button" className="outline" onClick={() => notify(active + ' module selected')}>
                  Open module
                </button>
              </div>
            ) : (
              <>
                <div className="stats">
                  <Stat icon={<Users aria-hidden="true" />} tone="violet" label="Active Clients" value={clientsLoaded ? String(clientRows.length) : '…'} />
                  <Stat
                    icon={<CalendarDays aria-hidden="true" />}
                    tone="blue"
                    label="Scheduled Posts"
                    value={overviewStats ? String(overviewStats.scheduledPosts) : '…'}
                  />
                  <Stat
                    icon={<Activity aria-hidden="true" />}
                    tone="teal"
                    label="Leads This Month"
                    value={overviewStats ? String(overviewStats.leadsThisMonth) : '…'}
                  />
                  <Stat
                    icon={<ShieldCheck aria-hidden="true" />}
                    tone="green"
                    label="AI Health"
                    value={overviewStats ? (overviewStats.healthScore != null ? overviewStats.healthScore + '%' : 'No data yet') : '…'}
                  />
                </div>
                <div className="two-col">
                  <section className="card">
                    <Title text="Recent Activity" />
                    <div className="monitor">
                      <div className="timeline" role="list" aria-label="Recent activity">
                        {overviewStats && overviewStats.recentActivity.length === 0 && (
                          <p style={{ opacity: 0.7 }}>No activity yet.</p>
                        )}
                        {overviewStats?.recentActivity.map(item => (
                          <Timeline
                            key={item.id}
                            text={item.action.replace(/[._]/g, ' ')}
                            meta={(item.workspaces?.name ?? 'Agency') + '  •  ' + timeAgo(item.at)}
                          />
                        ))}
                      </div>
                      <div className="bot-area">
                        {/* A plain <img> (not next/image) keeps the approved markup exactly. */}
                        <img
                          className="bot-image"
                          src="/resources/ai-working-247.png"
                          alt="AI working for your success 24/7"
                        />
                      </div>
                    </div>
                  </section>
                  <section className="card">
                    <Title text="Leads and ROAS" />
                    <p style={{ padding: '8px 0', opacity: 0.7 }}>
                      Not enough data yet to show a trend — this fills in as clients get real leads and ad campaigns.
                    </p>
                  </section>
                </div>
                <div className="two-col lower">
                  {clientWorkspacesCard}
                  <section className="card">
                    <Title text="Approval Queue" />
                    {approvalsLoaded && approvals.length === 0 && (
                      <p style={{ padding: '8px 0', opacity: 0.7 }}>No pending approvals.</p>
                    )}
                    {approvals.map(item => (
                      <Approval
                        key={item.id}
                        title={item.title}
                        client={item.workspaces?.name ?? 'Unknown client'}
                        age={timeAgo(item.created_at)}
                        kind={approvalKind(item.module)}
                        done={decidingApprovalId === item.id}
                        onApprove={() => decideApproval(item.id, 'approved')}
                      />
                    ))}
                  </section>
                </div>
              </>
            )}
          </section>
          {/* Screen readers hear every message, even after the visual toast has gone. */}
          <div className="sr-only" role="status" aria-live="polite">
            {announcement}
          </div>
          <div className="sr-only" aria-live="polite">
            {navAnnouncement}
          </div>
          {toast && (
            <div
              className="toast"
              onMouseEnter={pauseToastTimer}
              onMouseLeave={startToastTimer}
              onFocus={pauseToastTimer}
              onBlur={startToastTimer}
            >
              <Check size={16} aria-hidden="true" /> {toast}
              <button type="button" aria-label="Dismiss notification" onClick={dismissToast}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
