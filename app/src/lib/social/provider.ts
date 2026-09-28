import type { Network, Plan, ChannelStatus } from './types';

/**
 * What any publishing provider must be able to do. Phase 3 has ONE implementation - the sandbox,
 * a pretend provider that lives entirely in memory. The real Buffer provider does not exist yet
 * and cannot be created (see sources.ts).
 */

export interface ProviderChannel {
  externalId: string;
  network: Network;
  displayName: string;
  handle: string;
  status: ChannelStatus;
}

export interface PublishRequest {
  /**
   * The SAME key is used for every attempt at one post. A provider that honours it will never
   * publish the same post twice, even if we retry after not hearing back.
   */
  idempotencyKey: string;
  channelExternalId: string;
  network: Network;
  body: string;
  imageAlt?: string | null;
}

export type PublishFailure = 'rate_limited' | 'rejected' | 'channel_unavailable' | 'temporary';

export type PublishResult =
  | { ok: true; externalPostId: string; publishedAt: string }
  | { ok: false; code: PublishFailure; message: string; retryAfterSeconds?: number };

export interface SocialProvider {
  readonly kind: 'sandbox' | 'buffer';
  getPlan(): Promise<Plan>;
  listChannels(): Promise<ProviderChannel[]>;
  publish(request: PublishRequest): Promise<PublishResult>;
}
