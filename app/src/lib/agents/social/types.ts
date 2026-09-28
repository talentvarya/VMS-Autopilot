/**
 * Social Media Super Agent (Sub-phase B) - shared vocabulary. Mirrors the tables in
 * supabase/migrations/20260929000200_social_super_agent.sql.
 *
 * There is deliberately no "sending" or "sent" status for a reply yet - this phase never
 * sends anything (see replies.ts and agent.ts). Publishing a post still goes entirely through
 * the EXISTING Phase 3 machinery (src/lib/social) - nothing here duplicates it.
 */

import type { Network } from '@/lib/social/types';

export const INTERACTION_KINDS = ['comment', 'dm'] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const INTERACTION_STATUSES = ['new', 'drafted', 'ignored'] as const;
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

export const REPLY_STATUSES = ['drafted', 'in_review', 'approved', 'cancelled'] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

export const CALENDAR_STATUSES = ['planned', 'drafted', 'skipped'] as const;
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

/** An incoming comment or DM. body_raw is DATA - see replies.ts for why it is never treated as instructions. */
export interface SocialInteraction {
  id: string;
  workspaceId: string;
  channelId: string;
  kind: InteractionKind;
  externalInteractionId: string;
  authorHandle: string | null;
  bodyRaw: string;
  status: InteractionStatus;
  intentFlag: string | null;
}

export interface SocialReplyDraft {
  id: string;
  workspaceId: string;
  interactionId: string;
  body: string;
  status: ReplyStatus;
  draftedByAgent: boolean;
  createdBy: string | null;
  approvedBy: string | null;
  approvedHash: string | null;
}

export interface CalendarItem {
  id: string;
  workspaceId: string;
  plannedDate: string;
  theme: string;
  targetNetworks: readonly Network[];
  status: CalendarStatus;
  linkedPostIds: readonly string[];
  generatedByAgent: boolean;
}

export interface BrandVoiceProfile {
  workspaceId: string;
  tone: string | null;
  prohibitedWords: readonly string[];
  examplePosts: readonly string[];
}
