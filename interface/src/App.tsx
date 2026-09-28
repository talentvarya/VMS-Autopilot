import { useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  Bell,
  Bot,
  CalendarDays,
  Check,
  ChevronDown,
  FileText,
  Globe2,
  Home,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  Megaphone,
} from 'lucide-react';

const nav = [
  ['Overview', Home],
  ['Clients', Users],
  ['Social Publishing', CalendarDays],
  ['SEO / GEO Audit', Search],
  ['Paid Ads', Megaphone],
  ['Domains', Globe2],
  ['Leads & CRM', Users],
  ['AI Monitor', Bot],
  ['Reports', FileText],
  ['Settings', Settings],
];
const clients = [
  {
    name: 'Nova Clinic',
    type: 'Healthcare',
    initial: 'N',
    score: 92,
    ads: 'Active',
    access: 'Full Access',
    health: 'Healthy',
    channels: ['f', 'ig', 'in', 'yt'],
  },
  {
    name: 'Bright Homes',
    type: 'Real Estate',
    initial: 'B',
    score: 78,
    ads: 'Paused',
    access: 'Limited',
    health: 'Needs Attention',
    channels: ['ig', 'in', 'tk'],
  },
  {
    name: 'Urban Eats',
    type: 'Food & Beverage',
    initial: 'U',
    score: 85,
    ads: 'Active',
    access: 'Full Access',
    health: 'Healthy',
    channels: ['f', 'ig', 'tk', 'yt'],
  },
];

function App() {
  const [active, setActive] = useState('Overview');
  const [workspace, setWorkspace] = useState('Acme Marketing');
  const [workspaces, setWorkspaces] = useState(false);
  const [clientRows, setClientRows] = useState(clients);
  const [approved, setApproved] = useState<number[]>([]);
  const [toast, setToast] = useState('');
  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 2400);
  };
  const addClient = () => {
    setClientRows([
      ...clientRows,
      {
        name: 'New Client',
        type: 'New workspace',
        initial: 'N',
        score: 0,
        ads: 'Paused',
        access: 'Limited',
        health: 'Needs Attention',
        channels: ['ig'],
      },
    ]);
    notify('New client workspace created');
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">V</span>
          <div>
            <strong>VMS Autopilot</strong>
            <small>
              AI-Powered Marketing
              <br />
              Automation Platform
            </small>
          </div>
        </div>
        <nav>
          {nav.map(([label, Icon]) => (
            <button
              key={String(label)}
              className={active === label ? 'nav-item active' : 'nav-item'}
              onClick={() => setActive(String(label))}
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="side-footer">
          <div></div>Smarter marketing.
          <br />
          Happier clients.
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <div className="mobile-brand">
              <Menu size={18} /> VMS Autopilot
            </div>
            <h1>Good morning, Admin</h1>
            <p>Here’s what’s happening with your agency today.</p>
          </div>
          <div className="actions">
            <div className="workspace-wrap">
              <button
                className="workspace"
                onClick={() => setWorkspaces(!workspaces)}
              >
                <ShieldCheck size={17} />
                {workspace}
                <ChevronDown size={15} />
              </button>
              {workspaces && (
                <div className="workspace-menu">
                  {['Acme Marketing', 'VMS Demo Agency', 'Client Sandbox'].map(
                    item => (
                      <button
                        key={item}
                        onClick={() => {
                          setWorkspace(item);
                          setWorkspaces(false);
                        }}
                      >
                        {item}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
            <button className="primary" onClick={addClient}>
              <Plus size={16} /> Add client
            </button>
            <button className="bell">
              <Bell size={20} />
              <i>3</i>
            </button>
            <div className="avatar">
              A<b />
            </div>
          </div>
        </header>
        <section className="content">
          <div className="heading">
            <h2>{active === 'Overview' ? 'Agency Overview' : active}</h2>
            <button className="date">
              <CalendarDays size={16} /> Apr 1, 2025 – Apr 30, 2025{' '}
              <ChevronDown size={15} />
            </button>
          </div>
          {active !== 'Overview' ? (
            <div className="module">
              <div className="module-icon">
                <Sparkles size={28} />
              </div>
              <div>
                <h3>{active}</h3>
                <p>
                  This module is ready for the next implementation phase. Admin
                  permissions control client access here.
                </p>
              </div>
              <button
                className="outline"
                onClick={() => notify(active + ' module selected')}
              >
                Open module
              </button>
            </div>
          ) : (
            <>
              <div className="stats">
                <Stat
                  icon={<Users />}
                  tone="violet"
                  label="Active Clients"
                  value="24"
                  change="+14%"
                />
                <Stat
                  icon={<CalendarDays />}
                  tone="blue"
                  label="Scheduled Posts"
                  value="186"
                  change="+26%"
                />
                <Stat
                  icon={<Activity />}
                  tone="teal"
                  label="Leads This Month"
                  value="1,248"
                  change="+38%"
                />
                <Stat
                  icon={<ShieldCheck />}
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
                        <Activity size={14} /> Last checked: Apr 24, 2025, 9:12
                        AM
                      </span>
                    }
                  />
                  <div className="healthy">
                    <b>
                      <Check size={20} />
                    </b>
                    <div>
                      <strong>All systems healthy</strong>
                      <p>Your AI operations are running smoothly.</p>
                    </div>
                  </div>
                  <div className="monitor">
                    <div className="timeline">
                      <Timeline
                        text="SEO audit completed"
                        meta="Nova Clinic  •  2 minutes ago"
                      />
                      <Timeline
                        text="3 posts scheduled"
                        meta="Bright Homes  •  12 minutes ago"
                      />
                      <Timeline
                        text="Domain SSL renewed"
                        meta="Urban Eats  •  28 minutes ago"
                      />
                    </div>
                    <div className="bot-area">
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
                  <div className="chart">
                    <div className="bars">
                      {[
                        34, 45, 39, 53, 60, 70, 58, 75, 82, 92, 105, 91, 112,
                        126, 135,
                      ].map((height, index) => (
                        <i
                          key={index}
                          style={{ height: String(height) + 'px' }}
                        />
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
                <section className="card">
                  <Title
                    text="Client Workspaces"
                    right={
                      <button
                        className="link"
                        onClick={() => setActive('Clients')}
                      >
                        View all clients <ArrowUpRight size={15} />
                      </button>
                    }
                  />
                  <div className="table-head">
                    <span>Client</span>
                    <span>Channels</span>
                    <span>SEO/GEO Score</span>
                    <span>Ads Status</span>
                    <span>Permission</span>
                    <span>Health</span>
                    <span />
                  </div>
                  {clientRows.map(client => (
                    <div
                      className="client-row"
                      key={client.name + client.initial}
                    >
                      <div className="client-name">
                        <b
                          className={
                            'client-avatar ' + client.initial.toLowerCase()
                          }
                        >
                          {client.initial}
                        </b>
                        <div>
                          <strong>{client.name}</strong>
                          <small>{client.type}</small>
                        </div>
                      </div>
                      <div className="channels">
                        {client.channels.map(item => (
                          <span className={'channel ' + item} key={item}>
                            {item}
                          </span>
                        ))}
                      </div>
                      <div className="score">{client.score}</div>
                      <div className={'status ' + client.ads.toLowerCase()}>
                        <i />
                        {client.ads}
                      </div>
                      <span
                        className={
                          'pill ' +
                          (client.access === 'Full Access' ? 'full' : 'limited')
                        }
                      >
                        {client.access}
                      </span>
                      <div
                        className={
                          'status ' +
                          (client.health === 'Healthy'
                            ? 'healthy'
                            : 'attention')
                        }
                      >
                        <i />
                        {client.health}
                      </div>
                      <MoreHorizontal size={17} className="more" />
                    </div>
                  ))}
                </section>
                <section className="card">
                  <Title
                    text="Approval Queue"
                    right={
                      <button
                        className="link"
                        onClick={() => notify('Approval queue opened')}
                      >
                        View all <ArrowUpRight size={15} />
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
        {toast && (
          <div className="toast">
            <Check size={16} /> {toast}
            <button onClick={() => setToast('')}>
              <X size={14} />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({
  icon,
  tone,
  label,
  value,
  change,
}: {
  icon: ReactNode;
  tone: string;
  label: string;
  value: string;
  change: string;
}) {
  return (
    <div className="stat">
      <div className={'stat-icon ' + tone}>{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <em>
          ↗ {change} <small>vs last month</small>
        </em>
      </div>
    </div>
  );
}
function Title({ text, right }: { text: string; right?: ReactNode }) {
  return (
    <div className="title">
      <h3>{text}</h3>
      {right}
    </div>
  );
}
function Timeline({ text, meta }: { text: string; meta: string }) {
  return (
    <div className="timeline-item">
      <i />
      <div>
        <strong>{text}</strong>
        <p>{meta}</p>
      </div>
    </div>
  );
}
function Approval({
  title,
  client,
  age,
  kind,
  done,
  onApprove,
}: {
  title: string;
  client: string;
  age: string;
  kind: string;
  done: boolean;
  onApprove: () => void;
}) {
  return (
    <div className="approval">
      <span className={'approval-icon ' + kind}>
        {kind === 'ads' ? (
          <Megaphone size={16} />
        ) : kind === 'post' ? (
          <FileText size={16} />
        ) : (
          <Globe2 size={16} />
        )}
      </span>
      <div>
        <strong>{title}</strong>
        <small>
          {client} • {age}
        </small>
      </div>
      {done ? (
        <span className="done">
          <Check size={13} /> Approved
        </span>
      ) : (
        <button
          className={kind === 'post' ? 'review' : 'approve'}
          onClick={onApprove}
        >
          {kind === 'post' ? 'Review' : 'Approve'}
        </button>
      )}
      <MoreHorizontal size={17} className="more" />
    </div>
  );
}
export default App;

