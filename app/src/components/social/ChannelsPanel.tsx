'use client';

import { Title } from '../dashboard/parts';
import { NETWORK_LABELS, type Channel, type ChannelStatus, type Plan } from '@/lib/social/types';

const STATUS_LABEL: Record<ChannelStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  disconnected: 'Disconnected',
  expired: 'Needs reconnecting',
};

export default function ChannelsPanel({
  channels, plan, canPause, isAdmin, onToggle, onAddSample,
}: {
  channels: Channel[];
  plan: Plan;
  canPause: boolean;
  isAdmin: boolean;
  onToggle: (channelId: string, status: 'active' | 'paused') => void;
  onAddSample: () => void;
}) {
  const used = channels.filter((c) => c.status !== 'disconnected').length;
  const left = Math.max(0, plan.channelLimit - used);
  const pct = plan.channelLimit === 0 ? 100 : Math.min(100, Math.round((used / plan.channelLimit) * 100));

  return (
    <section className="card">
      <Title text="Channels" />
      <p className="soc-planline">
        <strong>{plan.name}</strong>: {used} of {plan.channelLimit} channel{plan.channelLimit === 1 ? '' : 's'} used
        {left === 0 ? ', no free slots left' : `, ${left} free`}.
      </p>
      <span className="soc-meter" role="img" aria-label={`${used} of ${plan.channelLimit} channel slots used`}>
        <i className={left === 0 ? 'full' : ''} style={{ width: `${pct}%` }} />
      </span>
      <p className="soc-hint">Each Instagram account, Facebook Page, LinkedIn page and so on counts as one channel.</p>

      <ul className="soc-channels">
        {channels.map((c) => (
          <li key={c.id}>
            <span className={'soc-net ' + c.network}>{NETWORK_LABELS[c.network]}</span>
            <span className="soc-channel-name">
              <strong>{c.displayName}</strong>
              <small>{c.handle}</small>
            </span>
            <span className={'soc-chip ' + c.status}>{STATUS_LABEL[c.status]}</span>
            {canPause && (c.status === 'active' || c.status === 'paused') && (
              <button type="button" className="outline soc-btn" onClick={() => onToggle(c.id, c.status === 'active' ? 'paused' : 'active')} aria-label={`${c.status === 'active' ? 'Pause' : 'Resume'} ${NETWORK_LABELS[c.network]}: ${c.displayName}`}>
                {c.status === 'active' ? 'Pause' : 'Resume'}
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="soc-connect">
        <button type="button" className="outline soc-btn" aria-disabled="true" aria-describedby="soc-connect-help">
          Connect Buffer
        </button>
        {isAdmin && (
          <button type="button" className="outline soc-btn" onClick={onAddSample}>
            Add a sample channel
          </button>
        )}
        <p id="soc-connect-help" className="soc-hint">
          Connecting real accounts is switched off. Your agency has to approve it first. Nothing on this page is connected to Buffer or to any social network.
        </p>
      </div>
    </section>
  );
}
