/**
 * Social publishing vocabulary (Phase 3). Mirrors the Postgres enums in
 * supabase/migrations/20260928000500_social.sql - tests/db/social.test.ts checks it.
 *
 * Phase 3 is SANDBOX ONLY: nothing here connects to Buffer or to any social network.
 */

/** Each Instagram account, Facebook Page, X profile, ... is ONE channel (PRD 5.5). */
export const NETWORKS = ['instagram', 'facebook', 'x', 'linkedin', 'google_business', 'youtube', 'tiktok'] as const;
export type Network = (typeof NETWORKS)[number];

export const NETWORK_LABELS: Record<Network, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook Page',
  x: 'X',
  linkedin: 'LinkedIn',
  google_business: 'Google Business Profile',
  youtube: 'YouTube',
  tiktok: 'TikTok',
};

export const POST_STATUSES = ['draft', 'in_review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  draft: 'Draft',
  in_review: 'Waiting for approval',
  approved: 'Approved',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const CHANNEL_STATUSES = ['active', 'paused', 'disconnected', 'expired'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** 'buffer' exists in the vocabulary but the database refuses it until a later, approved migration. */
export const PROVIDERS = ['sandbox', 'buffer'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PLAN_TIERS = ['free', 'paid'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const PUBLISH_RESULTS = ['success', 'failed', 'rate_limited'] as const;
export type PublishResultKind = (typeof PUBLISH_RESULTS)[number];

export interface Channel {
  id: string;
  workspaceId: string;
  network: Network;
  externalId: string;
  displayName: string;
  handle: string;
  status: ChannelStatus;
}

export interface Plan {
  tier: PlanTier;
  name: string;
  /** How many channels the plan allows. The provider decides this, never us. */
  channelLimit: number;
}

export interface SocialPost {
  id: string;
  workspaceId: string;
  channelId: string;
  /** Posts written together for several channels share a group. */
  groupId: string | null;
  body: string;
  imageAlt: string | null;
  status: PostStatus;
  /** ISO time, UTC. */
  scheduledAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Fingerprint of exactly what was approved. Publishing refuses if the text no longer matches. */
  approvedHash: string | null;
  publishedAt: string | null;
  externalPostId: string | null;
  /** Plain-words reason shown to people. Never internal detail. */
  lastError: string | null;
  attemptCount: number;
}

/** Hard safety limits. The database enforces the same numbers. */
export const LIMITS = {
  /** No more than this many posts per channel per (UTC) day may be scheduled or published. */
  maxPostsPerChannelPerDay: 10,
  /** Scheduling window. */
  minLeadMinutes: 5,
  maxDaysAhead: 90,
  /** A failed post may be tried at most this many times. */
  maxAttempts: 3,
  /** Drafts per workspace per day (stops floods). */
  maxNewPostsPerWorkspacePerDay: 200,
  maxImageAltChars: 500,
} as const;
