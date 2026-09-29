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
import { Approval, Stat, Timeline, Title } from './dashboard/parts';
import { channelNames, chartBars, nav, workspaceOptions, type ClientRow } from './dashboard/data';

type WorkspaceApiRow = { id: string; name: string; industry: string | null; kind: string; created_at: string };

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

const DEFAULT_TITLE = 'VMS Autopilot — AI-Powered Marketing Automation Platform';

/**
 * The approved VMS Autopilot dashboard, ported from interface/src/App.tsx.
 * Markup, class names and styles are unchanged. Additions are invisible on desktop:
 * accessibility labels/roles, keyboard handling, and a slide-in navigation drawer that
 * only appears below 1100px wide.
 */
export default function Dashboard() {
  const [active, setActive] = useState('Overview');
  const [workspace, setWorkspace] = useState('Acme Marketing');
  const [workspaces, setWorkspaces] = useState(false);
  const [clientRows, setClientRows] = useState<ClientRow[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [approved, setApproved] = useState<number[]>([]);
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
                  <Stat icon={<Users aria-hidden="true" />} tone="violet" label="Active Clients" value="24" change="+14%" />
                  <Stat
                    icon={<CalendarDays aria-hidden="true" />}
                    tone="blue"
                    label="Scheduled Posts"
                    value="186"
                    change="+26%"
                  />
                  <Stat
                    icon={<Activity aria-hidden="true" />}
                    tone="teal"
                    label="Leads This Month"
                    value="1,248"
                    change="+38%"
                  />
                  <Stat
                    icon={<ShieldCheck aria-hidden="true" />}
                    tone="green"
                    label="AI Health"
                    value="98%"
                    change="+2%"
                  />
                </div>
                <div className="two-col">
                  <section className="card">
                    <Title
                      text="AI Operations Monitor"
                      right={
                        <span className="checked">
                          <Activity size={14} aria-hidden="true" /> Last checked: Apr 24, 2025, 9:12 AM
                        </span>
                      }
                    />
                    <div className="healthy">
                      <b aria-hidden="true">
                        <Check size={20} />
                      </b>
                      <div>
                        <strong>All systems healthy</strong>
                        <p>Your AI operations are running smoothly.</p>
                      </div>
                    </div>
                    <div className="monitor">
                      <div className="timeline" role="list" aria-label="Recent AI activity">
                        <Timeline text="SEO audit completed" meta="Nova Clinic  •  2 minutes ago" />
                        <Timeline text="3 posts scheduled" meta="Bright Homes  •  12 minutes ago" />
                        <Timeline text="Domain SSL renewed" meta="Urban Eats  •  28 minutes ago" />
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
                    <Title
                      text="Leads and ROAS"
                      right={
                        <div className="roas">
                          <strong>↗ +42%</strong>
                          <span>Leads MoM</span>
                          <b>3.2</b>
                          <span>Avg ROAS</span>
                        </div>
                      }
                    />
                    <div className="legend">
                      <span>● Leads</span>
                      <span>● ROAS</span>
                    </div>
                    <div
                      className="chart"
                      role="img"
                      aria-label="Chart of daily leads (bars) and ROAS (line) for April 2025. Leads rose from 34 to 135, up 42 percent month on month, with an average ROAS of 3.2."
                    >
                      <div className="bars">
                        {chartBars.map((height, index) => (
                          <i key={index} style={{ height: String(height) + 'px' }} />
                        ))}
                      </div>
                      <svg viewBox="0 0 600 150" preserveAspectRatio="none">
                        <polyline
                          points="5,116 45,100 85,108 125,87 165,95 205,78 245,63 285,70 325,45 365,50 405,30 445,42 485,25 525,15 595,2"
                          fill="none"
                          stroke="#09b8b2"
                          strokeWidth="3"
                        />
                      </svg>
                      <div className="x-axis">
                        <span>Apr 1</span>
                        <span>Apr 7</span>
                        <span>Apr 14</span>
                        <span>Apr 21</span>
                        <span>Apr 28</span>
                      </div>
                    </div>
                  </section>
                </div>
                <div className="two-col lower">
                  {clientWorkspacesCard}
                  <section className="card">
                    <Title
                      text="Approval Queue"
                      right={
                        <button type="button" className="link" onClick={() => notify('Approval queue opened')}>
                          View all <ArrowUpRight size={15} aria-hidden="true" />
                        </button>
                      }
                    />
                    <Approval
                      title="Meta campaign budget change"
                      client="Nova Clinic"
                      age="2 hours ago"
                      kind="ads"
                      done={approved.includes(1)}
                      onApprove={() => {
                        setApproved([...approved, 1]);
                        notify('Approval completed and logged');
                      }}
                    />
                    <Approval
                      title="LinkedIn post"
                      client="Bright Homes"
                      age="4 hours ago"
                      kind="post"
                      done={approved.includes(2)}
                      onApprove={() => notify('Review opened for Admin')}
                    />
                    <Approval
                      title="Domain DNS update"
                      client="Urban Eats"
                      age="6 hours ago"
                      kind="domain"
                      done={approved.includes(3)}
                      onApprove={() => {
                        setApproved([...approved, 3]);
                        notify('Approval completed and logged');
                      }}
                    />
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
