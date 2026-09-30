'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
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
import ConnectedAccounts from './ConnectedAccounts';
import SeoAuditModule from './SeoAuditModule';
import SocialModule from './SocialModule';
import { Approval, SimpleTable, Stat, Timeline, Title } from './dashboard/parts';
import { channelNames, nav, type ClientRow } from './dashboard/data';
import { useLazyList } from './dashboard/hooks';
import { useRouter } from 'next/navigation';
import { createClient as createBrowserSupabaseClient } from '@/lib/supabase/client';

type WorkspaceApiRow = { id: string; name: string; industry: string | null; kind: string; website_url: string | null; created_at: string };
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
  workspace_id: string;
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
type NotificationRow = {
  id: string;
  workspace_id: string | null;
  kind: string;
  title: string;
  body: string;
  related_id: string | null;
  read_at: string | null;
  created_at: string;
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
    websiteUrl: w.website_url,
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

// The real current month, e.g. "Sep 1, 2026 - Sep 30, 2026" - replaces a hardcoded "Apr 1,
// 2025 - Apr 30, 2025" that never changed no matter what today's date actually was.
function currentMonthRange(now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
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
  const [agencyName, setAgencyName] = useState<string | null>(null);
  const [clientRows, setClientRows] = useState<ClientRow[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalApiRow[]>([]);
  const [approvalsLoaded, setApprovalsLoaded] = useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [navAnnouncement, setNavAnnouncement] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);

  const toastTimer = useRef<number | undefined>(undefined);
  const announceCount = useRef(0);
  const firstRender = useRef(true);
  const returnFocus = useRef<'toggle' | 'main' | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const notifButtonRef = useRef<HTMLButtonElement>(null);
  const notifWrapRef = useRef<HTMLDivElement>(null);

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

  // Picks up the redirect back from /api/integrations/buffer/callback (real Buffer OAuth,
  // Phase G.11) and shows the result as a toast, then strips the query string so refreshing
  // the page doesn't repeat the message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('buffer');
    if (!status) return;
    const message = params.get('bufferMessage') ?? '';
    notify(status === 'connected' ? `Buffer connected (${message})` : `Buffer connection failed: ${message}`);
    setActive('Connected Accounts');
    router.replace('/', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const websiteUrl = window.prompt('Client\'s website (optional - used for real SEO/GEO audits)? Leave blank to skip.')?.trim() || undefined;
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, websiteUrl }),
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

  const [openClientMenuId, setOpenClientMenuId] = useState<string | null>(null);

  const renameClient = async (id: string, currentName: string) => {
    const name = window.prompt('Rename client', currentName)?.trim();
    if (!name || name === currentName) return;
    try {
      const res = await fetch(`/api/workspaces/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not rename client');
        return;
      }
      setClientRows(rows => rows.map(row => (row.id === id ? toClientRow({ id, name, industry: row.type, kind: 'client', website_url: row.websiteUrl, created_at: '' }) : row)));
      notify('Renamed to ' + name);
    } catch {
      notify('Could not rename client — check your connection');
    }
  };

  const editClientWebsite = async (id: string, currentUrl: string | null) => {
    const input = window.prompt('Client\'s website URL (blank to remove)', currentUrl ?? '')?.trim() ?? null;
    if (input === null) return;
    try {
      const res = await fetch(`/api/workspaces/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteUrl: input }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not update the website');
        return;
      }
      setClientRows(rows => rows.map(row => (row.id === id ? { ...row, websiteUrl: body.workspace.website_url } : row)));
      notify(input ? 'Website saved' : 'Website removed');
    } catch {
      notify('Could not update the website — check your connection');
    }
  };

  const archiveClient = async (id: string, name: string) => {
    if (!window.confirm(`Archive ${name}? It will be hidden from the client list.`)) return;
    try {
      const res = await fetch(`/api/workspaces/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive: true }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not archive client');
        return;
      }
      setClientRows(rows => rows.filter(row => row.id !== id));
      notify(name + ' archived');
    } catch {
      notify('Could not archive client — check your connection');
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

  const [campaigns, campaignsLoaded, setCampaigns] = useLazyList<CampaignRow>(active, 'Paid Ads', '/api/ad-campaigns', notify, 'campaigns');
  const [leads, leadsLoaded, setLeads] = useLazyList<LeadRow>(active, 'Leads & CRM', '/api/leads', notify, 'leads');
  const [websiteProjects, websiteProjectsLoaded, setWebsiteProjects] = useLazyList<WebsiteProjectRow>(active, 'Domains', '/api/website-projects', notify, 'domain projects');

  // Every "Add X" prompt below asks for a client by name, then resolves it against the real
  // client list already loaded for the Clients tab - avoids building a picker component for
  // what is, today, always a short list.
  const findClientByName = (): { id: string; name: string } | null => {
    if (clientRows.length === 0) {
      notify('Add a client first');
      return null;
    }
    const typed = window.prompt(`Which client? (${clientRows.map(c => c.name).join(', ')})`)?.trim().toLowerCase();
    if (!typed) return null;
    const match = clientRows.find(c => c.name.toLowerCase() === typed);
    if (!match) {
      notify('No client matches that name');
      return null;
    }
    return { id: match.id, name: match.name };
  };

  const addLead = async () => {
    const client = findClientByName();
    if (!client) return;
    const name = window.prompt('Lead name (or leave blank if you only have contact info)')?.trim() || null;
    const contact = window.prompt('Contact (phone, email, @handle)')?.trim() || null;
    if (!name && !contact) return;
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: client.id, name, contact }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not add lead');
        return;
      }
      setLeads(rows => [body.row as LeadRow, ...rows]);
      notify('Lead added for ' + client.name);
    } catch {
      notify('Could not add lead — check your connection');
    }
  };

  const addCampaign = async () => {
    const client = findClientByName();
    if (!client) return;
    const name = window.prompt('Campaign name?')?.trim();
    if (!name) return;
    const objective = window.prompt('Objective? (e.g. Leads, Awareness, Traffic)')?.trim() || 'Awareness';
    try {
      const res = await fetch('/api/ad-campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: client.id, name, objective }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not add campaign');
        return;
      }
      setCampaigns(rows => [body.row as CampaignRow, ...rows]);
      notify('Draft campaign created for ' + client.name);
    } catch {
      notify('Could not add campaign — check your connection');
    }
  };

  const addWebsiteProject = async () => {
    const client = findClientByName();
    if (!client) return;
    const title = window.prompt('Project title?')?.trim();
    if (!title) return;
    try {
      const res = await fetch('/api/website-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: client.id, title }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not add project');
        return;
      }
      setWebsiteProjects(rows => [body.row as WebsiteProjectRow, ...rows]);
      notify('Project added for ' + client.name);
    } catch {
      notify('Could not add project — check your connection');
    }
  };

  const qualifyLead = async (leadId: string, workspaceId: string, status: string) => {
    try {
      const res = await fetch('/api/agents/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'qualify_lead', workspaceId, leadId, status }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not update that lead');
        return;
      }
      setLeads(rows => rows.map(row => (row.id === leadId ? { ...row, status } : row)));
      notify('Lead marked ' + status);
    } catch {
      notify('Could not update that lead — check your connection');
    }
  };

  const draftFollowUpForLead = async (leadId: string, workspaceId: string, leadName: string) => {
    const context = window.prompt(`What should the AI mention in the follow-up to ${leadName}? (optional)`) || undefined;
    try {
      const res = await fetch('/api/agents/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'draft_follow_up', workspaceId, leadId, context }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not draft a follow-up');
        return;
      }
      notify('Follow-up drafted: ' + (body.output?.draftedBody ?? ''));
    } catch {
      notify('Could not draft a follow-up — check your connection');
    }
  };

  const submitCampaignForReview = async (campaignId: string) => {
    try {
      const res = await fetch(`/api/ad-campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_review' }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not submit that campaign');
        return;
      }
      setCampaigns(rows => rows.map(row => (row.id === campaignId ? { ...row, status: 'in_review' } : row)));
      notify('Campaign submitted for review');
    } catch {
      notify('Could not submit that campaign — check your connection');
    }
  };

  const submitWebsitePlanForReview = async (projectId: string) => {
    try {
      const res = await fetch(`/api/website-projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_review' }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not submit that project');
        return;
      }
      setWebsiteProjects(rows => rows.map(row => (row.id === projectId ? { ...row, status: 'in_review' } : row)));
      notify('Project submitted for review');
    } catch {
      notify('Could not submit that project — check your connection');
    }
  };

  const [domainSuggestions, setDomainSuggestions] = useState<{ name: string; available: boolean }[]>([]);
  const researchDomainNames = async () => {
    const businessName = window.prompt('Business name?')?.trim();
    if (!businessName) return;
    try {
      const namesRes = await fetch('/api/agents/website', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'research_domain_names', businessName }),
      });
      const namesBody = await namesRes.json();
      if (!namesRes.ok) {
        notify(namesBody.error || 'Could not research domain names');
        return;
      }
      const candidates = (namesBody.output?.suggestions as string[]) ?? [];
      const availRes = await fetch('/api/agents/website', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'check_domain_availability', candidates }),
      });
      const availBody = await availRes.json();
      const availability = (availBody.output?.availability as Record<string, boolean>) ?? {};
      setDomainSuggestions(candidates.map(name => ({ name, available: availability[name] ?? true })));
    } catch {
      notify('Could not research domain names — check your connection');
    }
  };

  const runMonitoringTask = async (task: 'check_stale_audits' | 'check_stale_social_publishing') => {
    if (clientRows.length === 0) {
      notify('Add a client first');
      return;
    }
    try {
      const res = await fetch('/api/agents/monitoring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, workspaceId: clientRows[0].id }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not run that repair');
        return;
      }
      const failedCount = (body.output?.failedCount as number | undefined) ?? 0;
      notify(failedCount > 0 ? `Repaired ${failedCount} stuck item(s)` : 'Nothing was stuck — no repair needed');
    } catch {
      notify('Could not run that repair — check your connection');
    }
  };

  const [agencyReport, setAgencyReport] = useState<string | null>(null);
  const generateAgencyReport = async () => {
    try {
      const res = await fetch('/api/agents/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'compile_agency_report' }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not generate the report');
        return;
      }
      setAgencyReport(body.report as string);
      notify('Report generated');
    } catch {
      notify('Could not generate the report — check your connection');
    }
  };

  const draftArticle = async () => {
    if (clientRows.length === 0) {
      notify('Add a client first');
      return;
    }
    const typed = window.prompt(`Which client is this for? (${clientRows.map(c => c.name).join(', ')})`)?.trim().toLowerCase();
    if (!typed) return;
    const client = clientRows.find(c => c.name.toLowerCase() === typed);
    if (!client) {
      notify('No client matches that name');
      return;
    }
    const title = window.prompt('Article title?')?.trim();
    if (!title) return;
    const topic = window.prompt('What is the article about?')?.trim();
    if (!topic) return;
    try {
      const res = await fetch('/api/agents/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: client.id, title, topic }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not draft that article');
        return;
      }
      notify('Article drafted for ' + client.name);
    } catch {
      notify('Could not draft that article — check your connection');
    }
  };

  const [seoAgentResult, setSeoAgentResult] = useState<string | null>(null);
  const runSeoAuditViaAgent = async () => {
    if (clientRows.length === 0) {
      notify('Add a client first');
      return;
    }
    const typed = window.prompt(`Which client is this for? (${clientRows.map(c => c.name).join(', ')})`)?.trim().toLowerCase();
    if (!typed) return;
    const client = clientRows.find(c => c.name.toLowerCase() === typed);
    if (!client) {
      notify('No client matches that name');
      return;
    }
    setSeoAgentResult('Running…');
    try {
      const res = await fetch('/api/agents/seo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'queue_audit', workspaceId: client.id, fixtureSite: 'nova-clinic' }),
      });
      const body = await res.json();
      if (!res.ok) {
        setSeoAgentResult(null);
        notify(body.error || 'Could not run the audit');
        return;
      }
      const run = body.run as { status: string; overall_score: number | null } | null;
      setSeoAgentResult(run ? `Audit ${run.status} — overall score: ${run.overall_score ?? 'n/a'}` : 'Audit queued');
      notify('Audit run via agent');
    } catch {
      setSeoAgentResult(null);
      notify('Could not run the audit — check your connection');
    }
  };

  const [audienceResult, setAudienceResult] = useState<string | null>(null);
  const runAudienceResearch = async () => {
    if (clientRows.length === 0) {
      notify('Add a client first');
      return;
    }
    const typed = window.prompt(`Which client is this for? (${clientRows.map(c => c.name).join(', ')})`)?.trim().toLowerCase();
    if (!typed) return;
    const client = clientRows.find(c => c.name.toLowerCase() === typed);
    if (!client) {
      notify('No client matches that name');
      return;
    }
    const industry = window.prompt('Industry? (e.g. restaurant, real estate, transport)')?.trim();
    if (!industry) return;
    const product = window.prompt('Main product/service?')?.trim();
    if (!product) return;
    try {
      const res = await fetch('/api/agents/ads-audience', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: 'finalize_audience_brief',
          workspaceId: client.id,
          businessProfile: { name: client.name, industry, product },
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        notify(body.error || 'Could not research the audience');
        return;
      }
      setAudienceResult(JSON.stringify(body.output, null, 2));
      notify('Audience brief finalized for ' + client.name);
    } catch {
      notify('Could not research the audience — check your connection');
    }
  };

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

  // --- Notifications menu: outside click closes it -------------------------------------
  useEffect(() => {
    if (!notifOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!notifWrapRef.current?.contains(event.target as Node)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [notifOpen]);

  const unread = notifications.filter(n => !n.read_at).length;

  // Real agency name (Phase G.17) - replaces a hardcoded, fake 3-item "switch workspace" menu.
  // A person belongs to exactly one agency here, so there is nothing real to switch between.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/agency');
        const body = await res.json();
        if (!cancelled && res.ok) setAgencyName(body.name);
      } catch {
        // Silent: the header just keeps showing "…" rather than breaking the whole page.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Real notifications (Phase G.14) - the calendar-approval reminder cron is what actually
  // writes these; this just reads and displays them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/notifications');
        const body = await res.json();
        if (!cancelled && res.ok) setNotifications(body.notifications ?? []);
      } catch {
        // Silent: the bell just shows nothing new rather than breaking the whole page.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const markNotificationRead = async (id: string) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    } catch {
      // Best-effort - a failed mark-as-read just means it shows unread again next reload.
    }
  };

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
              <div role="cell" style={{ position: 'relative' }}>
                <button
                  type="button"
                  aria-label={`More actions for ${client.name}`}
                  aria-expanded={openClientMenuId === client.id}
                  onClick={() => setOpenClientMenuId(id => (id === client.id ? null : client.id))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
                >
                  <MoreHorizontal size={17} className="more" aria-hidden="true" />
                </button>
                {openClientMenuId === client.id && (
                  <div
                    role="menu"
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: '100%',
                      zIndex: 10,
                      background: '#fff',
                      border: '1px solid #e2e5ec',
                      borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                      minWidth: 140,
                    }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setOpenClientMenuId(null); renameClient(client.id, client.name); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setOpenClientMenuId(null); editClientWebsite(client.id, client.websiteUrl); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      Website
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setOpenClientMenuId(null); archiveClient(client.id, client.name); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', color: '#c0392b' }}
                    >
                      Archive
                    </button>
                  </div>
                )}
              </div>
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
          <button
            type="button"
            className="brand"
            onClick={() => selectModule('Overview')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%' }}
          >
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
          </button>
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
              <span className="workspace" aria-label={`Agency: ${agencyName ?? 'loading'}`}>
                <ShieldCheck size={17} aria-hidden="true" />
                {agencyName ?? '…'}
              </span>
              <button type="button" className="primary" onClick={addClient}>
                <Plus size={16} aria-hidden="true" /> Add client
              </button>
              <div className="workspace-wrap" ref={notifWrapRef}>
                <button
                  type="button"
                  className="bell"
                  ref={notifButtonRef}
                  aria-label={`Notifications, ${unread} unread`}
                  aria-expanded={notifOpen}
                  aria-controls="notif-menu"
                  onClick={() => setNotifOpen(o => !o)}
                >
                  <Bell size={20} aria-hidden="true" />
                  <i aria-hidden="true">{unread}</i>
                </button>
                {notifOpen && (
                  <div className="workspace-menu" id="notif-menu" role="group" aria-label="Notifications" style={{ minWidth: 320, maxHeight: 360, overflowY: 'auto' }}>
                    {notifications.length === 0 ? (
                      <p style={{ padding: '10px 12px', margin: 0, opacity: 0.7 }}>No notifications yet.</p>
                    ) : (
                      notifications.map(n => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => markNotificationRead(n.id)}
                          style={{ textAlign: 'left', width: '100%', fontWeight: n.read_at ? 400 : 700, whiteSpace: 'normal', lineHeight: 1.3 }}
                        >
                          <span style={{ display: 'block' }}>{n.title}</span>
                          <span style={{ display: 'block', fontWeight: 400, fontSize: 12, opacity: 0.8 }}>{n.body}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <button type="button" className="avatar" aria-label="Account settings" onClick={() => selectModule('Settings')} style={{ cursor: 'pointer', border: 'none' }}>
                {(agencyName ?? userEmail ?? 'A').charAt(0).toUpperCase()}<b aria-hidden="true" />
              </button>
            </div>
          </header>
          <section className="content" aria-labelledby="page-heading">
            <div className="heading">
              {active !== 'Overview' && (
                <button
                  type="button"
                  className="outline soc-btn"
                  onClick={() => selectModule('Overview')}
                  style={{ marginRight: 10 }}
                  aria-label="Back to Overview"
                >
                  <ArrowLeft size={16} aria-hidden="true" /> Back
                </button>
              )}
              <h2 id="page-heading">{active === 'Overview' ? 'Agency Overview' : active}</h2>
              <button type="button" className="date">
                <CalendarDays size={16} aria-hidden="true" /> {currentMonthRange()}{' '}
                <ChevronDown size={15} aria-hidden="true" />
              </button>
            </div>
            {active === 'SEO / GEO Audit' ? (
              <SeoAuditModule notify={notify} realClients={clientRows.map(c => ({ id: c.id, name: c.name, websiteUrl: c.websiteUrl }))} />
            ) : active === 'Social Publishing' ? (
              <SocialModule notify={notify} realClients={clientRows.map(c => ({ id: c.id, name: c.name }))} />
            ) : active === 'Connected Accounts' ? (
              <ConnectedAccounts notify={notify} realClients={clientRows.map(c => ({ id: c.id, name: c.name }))} />
            ) : active === 'Clients' ? (
              clientWorkspacesCard
            ) : active === 'Paid Ads' ? (
              <>
              <section className="card">
                <Title
                  text="Ad Campaigns"
                  right={
                    <button type="button" className="link" onClick={addCampaign}>
                      <Plus size={15} aria-hidden="true" /> Add campaign
                    </button>
                  }
                />
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
                    {
                      header: '',
                      render: row =>
                        row.status === 'draft' ? (
                          <button type="button" className="outline" onClick={() => submitCampaignForReview(row.id)}>
                            Submit for review
                          </button>
                        ) : null,
                    },
                  ]}
                />
              </section>
              <section className="card" style={{ marginTop: 16 }}>
                <Title text="Audience Research (AI)" />
                <p style={{ padding: '4px 0 8px', opacity: 0.7 }}>
                  Real Ads Audience Agent - deterministic, business-agnostic persona/segment research (never a real ad account, never launches or spends anything).
                </p>
                <button type="button" className="primary" onClick={runAudienceResearch}>Research audience for a client</button>
                {audienceResult && <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, marginTop: 8 }}>{audienceResult}</pre>}
              </section>
              </>
            ) : active === 'Leads & CRM' ? (
              <section className="card">
                <Title
                  text="Leads"
                  right={
                    <button type="button" className="link" onClick={addLead}>
                      <Plus size={15} aria-hidden="true" /> Add lead
                    </button>
                  }
                />
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
                    {
                      header: 'Status',
                      render: row => (
                        <select
                          value={row.status}
                          onChange={e => qualifyLead(row.id, row.workspace_id, e.target.value)}
                          aria-label={`Status for ${row.name ?? 'this lead'}`}
                        >
                          {['new', 'contacted', 'qualified', 'converted', 'lost'].map(s => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      ),
                    },
                    { header: 'Created', render: row => timeAgo(row.created_at) },
                    {
                      header: '',
                      render: row => (
                        <button type="button" className="outline" onClick={() => draftFollowUpForLead(row.id, row.workspace_id, row.name ?? 'this lead')}>
                          AI follow-up
                        </button>
                      ),
                    },
                  ]}
                />
              </section>
            ) : active === 'Domains' ? (
              <>
                <section className="card">
                  <Title
                    text="Website Projects"
                    right={
                      <button type="button" className="link" onClick={addWebsiteProject}>
                        <Plus size={15} aria-hidden="true" /> Add project
                      </button>
                    }
                  />
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
                      {
                        header: '',
                        render: row =>
                          row.status === 'draft' ? (
                            <button type="button" className="outline" onClick={() => submitWebsitePlanForReview(row.id)}>
                              Submit for review
                            </button>
                          ) : null,
                      },
                    ]}
                  />
                </section>
                <section className="card">
                  <Title text="Domain Name Ideas (AI)" />
                  <p style={{ padding: '4px 0 12px', opacity: 0.7 }}>
                    Type a business name and get available domain suggestions — read-only, checks nothing live.
                  </p>
                  <button type="button" className="outline" onClick={researchDomainNames}>
                    <Sparkles size={15} aria-hidden="true" /> Suggest domain names
                  </button>
                  {domainSuggestions.length > 0 && (
                    <ul style={{ marginTop: 12 }}>
                      {domainSuggestions.map(s => (
                        <li key={s.name}>
                          {s.name} — {s.available ? 'looks available' : 'likely taken'}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            ) : active === 'AI Monitor' ? (
              <>
                <section className="card">
                  <Title
                    text="Maintenance"
                    right={
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="outline" onClick={() => runMonitoringTask('check_stale_audits')}>Repair stale audits</button>
                        <button type="button" className="outline" onClick={() => runMonitoringTask('check_stale_social_publishing')}>Repair stale social publishing</button>
                      </div>
                    }
                  />
                  <p style={{ padding: '4px 0', opacity: 0.7 }}>
                    Fails any audit or post that has been stuck &quot;running&quot;/&quot;publishing&quot; for more than 15 minutes (a worker crash, not a real block) - via the real Monitoring Agent.
                  </p>
                </section>
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
              <>
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

                <section className="card">
                  <Title
                    text="Agency Report (AI)"
                    right={<button type="button" className="outline" onClick={generateAgencyReport}>Generate report</button>}
                  />
                  {agencyReport ? (
                    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13 }}>{agencyReport}</pre>
                  ) : (
                    <p style={{ padding: '4px 0', opacity: 0.7 }}>Real, read-only summary via the Analytics Agent - SEO audits, leads, campaigns, open incidents.</p>
                  )}
                </section>

                <section className="card">
                  <Title text="Draft an Article (AI)" />
                  <p style={{ padding: '4px 0 8px', opacity: 0.7 }}>Via the real Content Agent - creates a draft only, never publishes anything.</p>
                  <button type="button" className="primary" onClick={draftArticle}>Draft article</button>
                </section>

                <section className="card">
                  <Title text="Sandbox SEO Audit (AI, via Agent)" />
                  <p style={{ padding: '4px 0 8px', opacity: 0.7 }}>
                    Same sample-site engine as the SEO / GEO Audit page, run through the real SEO/GEO Agent instead of directly - proves the agent+permission path end to end.
                  </p>
                  <button type="button" className="outline" onClick={runSeoAuditViaAgent}>Run sample audit via agent</button>
                  {seoAgentResult && <p style={{ padding: '8px 0', opacity: 0.85 }}>{seoAgentResult}</p>}
                </section>
              </>
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
