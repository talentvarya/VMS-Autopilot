import { contentHash } from './hash';
import type { Channel, Plan, PostStatus, SocialPost } from './types';

/**
 * SAMPLE data for Phase 3. Invented workspaces, channels and posts: no real account, no real
 * Buffer, nothing that exists outside this file. "Now" is fixed so the sample calendar always
 * shows the same April 2025 month as the dashboard's date range.
 */

export const FIXTURE_NOW = '2025-04-24T09:12:00.000Z';

export interface SampleWorkspace {
  id: string;
  label: string;
  plan: Plan;
  channels: Channel[];
  posts: SocialPost[];
}

const channel = (workspaceId: string, id: string, network: Channel['network'], displayName: string, handle: string, status: Channel['status'] = 'active'): Channel => ({
  id, workspaceId, network, externalId: `sandbox-${id}`, displayName, handle, status,
});

let counter = 0;
function post(
  workspaceId: string,
  channelId: string,
  status: PostStatus,
  body: string,
  when: { scheduledAt?: string; publishedAt?: string; createdAt?: string },
  extra: Partial<SocialPost> = {},
): SocialPost {
  const id = `sample-${++counter}`;
  const createdAt = when.createdAt ?? '2025-04-20T08:00:00.000Z';
  const approved = ['approved', 'scheduled', 'publishing', 'published'].includes(status) || (status === 'failed' && extra.approvedHash !== null);
  return {
    id, workspaceId, channelId, groupId: null, body, imageAlt: null, status,
    scheduledAt: when.scheduledAt ?? null, createdBy: 'client-nova', createdAt, updatedAt: createdAt,
    approvedBy: approved ? 'admin-1' : null, approvedAt: approved ? '2025-04-21T10:00:00.000Z' : null,
    approvedHash: approved ? contentHash(channelId, body, null) : null,
    publishedAt: when.publishedAt ?? null, externalPostId: status === 'published' ? `sandbox-${id}` : null,
    lastError: null, attemptCount: status === 'published' || status === 'failed' ? 1 : 0, ...extra,
  };
}

const NOVA = 'nova';
const BRIGHT = 'bright';

export const SAMPLE_WORKSPACES: SampleWorkspace[] = [
  {
    id: NOVA,
    label: 'Nova Clinic (sample)',
    // A free plan with all three of its slots in use: the page shows "0 slots left".
    plan: { tier: 'free', name: 'Free plan (sample)', channelLimit: 3 },
    channels: [
      channel(NOVA, 'nova-fb', 'facebook', 'Nova Clinic', 'novaclinic'),
      channel(NOVA, 'nova-ig', 'instagram', 'Nova Clinic', '@novaclinic'),
      channel(NOVA, 'nova-in', 'linkedin', 'Nova Clinic', 'nova-clinic'),
    ],
    posts: [
      post(NOVA, 'nova-fb', 'published', 'Our team is back from training and ready to see you. Book a check-up this week.', { publishedAt: '2025-04-08T09:00:00.000Z', createdAt: '2025-04-05T08:00:00.000Z' }),
      post(NOVA, 'nova-ig', 'published', 'A healthy smile starts with a regular check-up. #dentalcare #springcheckup', { publishedAt: '2025-04-15T12:00:00.000Z', createdAt: '2025-04-12T08:00:00.000Z' }),
      post(NOVA, 'nova-fb', 'failed', 'Spring offer: free dental check-up for new patients until the end of April. [sandbox:fail]', { createdAt: '2025-04-18T08:00:00.000Z' }, { lastError: 'The network did not accept this post. Please check it and try again.', attemptCount: 1 }),
      post(NOVA, 'nova-in', 'scheduled', 'We are proud to welcome Dr. A. Rao to the Nova Clinic team.', { scheduledAt: '2025-04-28T10:00:00.000Z' }),
      post(NOVA, 'nova-fb', 'scheduled', 'Reminder: the clinic is closed on Friday 2 May for a public holiday. Emergency line stays open.', { scheduledAt: '2025-05-01T08:30:00.000Z' }),
      post(NOVA, 'nova-ig', 'approved', 'Behind the scenes: how we keep our instruments spotless. #cleanandsafe', { createdAt: '2025-04-22T08:00:00.000Z' }),
      post(NOVA, 'nova-fb', 'in_review', 'Five simple habits for healthier gums. Read our tips on the website.', { createdAt: '2025-04-23T08:00:00.000Z' }, { createdBy: 'agency-writer' }),
      post(NOVA, 'nova-in', 'draft', 'Hiring: we are looking for a friendly receptionist to join our team.', { createdAt: '2025-04-24T07:30:00.000Z' }, { createdBy: 'agency-writer' }),
    ],
  },
  {
    id: BRIGHT,
    label: 'Bright Homes (sample)',
    plan: { tier: 'paid', name: 'Paid plan (sample)', channelLimit: 10 },
    channels: [
      channel(BRIGHT, 'bright-ig', 'instagram', 'Bright Homes', '@brighthomes'),
      channel(BRIGHT, 'bright-in', 'linkedin', 'Bright Homes', 'bright-homes'),
      channel(BRIGHT, 'bright-tk', 'tiktok', 'Bright Homes', '@brighthomes', 'paused'),
      channel(BRIGHT, 'bright-gb', 'google_business', 'Bright Homes - Springfield', 'springfield'),
    ],
    posts: [
      post(BRIGHT, 'bright-in', 'published', 'New listing: a bright three-bedroom family home close to schools and parks.', { publishedAt: '2025-04-10T09:30:00.000Z', createdAt: '2025-04-08T08:00:00.000Z' }),
      post(BRIGHT, 'bright-ig', 'scheduled', 'Open house this Saturday, 11am to 2pm. Come and say hello. #openhouse #springfield', { scheduledAt: '2025-04-26T08:00:00.000Z' }),
      post(BRIGHT, 'bright-gb', 'in_review', 'Open house this Saturday from 11am to 2pm at our Springfield office.', { createdAt: '2025-04-23T09:00:00.000Z' }, { createdBy: 'agency-writer' }),
      post(BRIGHT, 'bright-tk', 'draft', 'A 30-second tour of our newest listing.', { createdAt: '2025-04-24T06:00:00.000Z' }),
    ],
  },
];

export const workspaceById = (id: string) => SAMPLE_WORKSPACES.find((w) => w.id === id)!;
