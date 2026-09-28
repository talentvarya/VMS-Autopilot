import { NETWORK_LIMITS, charLength } from './networks';
import { sha256Hex } from './hash';
import type { ProviderChannel, PublishRequest, PublishResult, SocialProvider } from './provider';
import type { Plan } from './types';

/**
 * A PRETEND Buffer. It lives in memory, contacts nothing, needs no login and stores no secrets.
 * It behaves like a real provider in the ways that matter for testing our safety rules:
 * a plan with a channel limit, channels that can be paused, an idempotency key that prevents
 * double posting, and failures you can trigger on purpose by putting a marker in the text:
 *
 *   [sandbox:fail]       the network rejects the post (permanent)
 *   [sandbox:ratelimit]  the provider says "too many requests, try later"
 *   [sandbox:temporary]  a temporary hiccup on the FIRST try; the next try succeeds
 */

export class PlanLimitReachedError extends Error {
  constructor(limit: number) {
    super(`This plan allows ${limit} channel${limit === 1 ? '' : 's'} and all are in use. Remove a channel or upgrade the plan to add another.`);
    this.name = 'PlanLimitReachedError';
  }
}

export class DuplicateChannelError extends Error {
  constructor() {
    super('That channel is already connected. Each social profile can be connected only once.');
    this.name = 'DuplicateChannelError';
  }
}

export const DEFAULT_SANDBOX_PLAN: Plan = { tier: 'free', name: 'Sandbox free plan', channelLimit: 3 };

export interface SandboxOptions {
  plan?: Plan;
  channels?: ProviderChannel[];
  now?: () => Date;
}

export class SandboxProvider implements SocialProvider {
  readonly kind = 'sandbox' as const;
  private readonly plan: Plan;
  private readonly channels: ProviderChannel[];
  private readonly now: () => Date;
  /** Results that must never be repeated: keyed by idempotency key. */
  private readonly settled = new Map<string, PublishResult>();
  private readonly temporaryTried = new Set<string>();
  /** How many times each key actually reached the "network" - tests use this to prove no double posting. */
  readonly deliveries = new Map<string, number>();

  constructor(options: SandboxOptions = {}) {
    this.plan = options.plan ?? DEFAULT_SANDBOX_PLAN;
    this.channels = (options.channels ?? []).map((c) => ({ ...c }));
    this.now = options.now ?? (() => new Date());
  }

  async getPlan(): Promise<Plan> {
    return { ...this.plan };
  }

  async listChannels(): Promise<ProviderChannel[]> {
    return this.channels.map((c) => ({ ...c }));
  }

  /** Slots in use: everything except disconnected channels. */
  slotsUsed(): number {
    return this.channels.filter((c) => c.status !== 'disconnected').length;
  }

  addChannel(channel: ProviderChannel): void {
    if (this.channels.some((c) => c.network === channel.network && c.externalId === channel.externalId)) throw new DuplicateChannelError();
    if (this.slotsUsed() >= this.plan.channelLimit) throw new PlanLimitReachedError(this.plan.channelLimit);
    this.channels.push({ ...channel });
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const repeat = this.settled.get(request.idempotencyKey);
    if (repeat) return repeat; // same post asked for again: answer the same, deliver nothing

    const channel = this.channels.find((c) => c.externalId === request.channelExternalId && c.network === request.network);
    if (!channel || channel.status === 'disconnected' || channel.status === 'expired') {
      return { ok: false, code: 'channel_unavailable', message: 'This channel is not connected right now. Reconnect it, then try again.' };
    }
    if (channel.status === 'paused') {
      return { ok: false, code: 'channel_unavailable', message: 'This channel is paused. Resume it, then try again.' };
    }
    if (charLength(request.body) > NETWORK_LIMITS[request.network].maxChars) {
      return this.settle(request, { ok: false, code: 'rejected', message: 'The network would not accept this post because it is too long.' });
    }

    if (request.body.includes('[sandbox:ratelimit]')) {
      return { ok: false, code: 'rate_limited', message: 'The provider asked us to slow down. It is safe to try again in a minute.', retryAfterSeconds: 60 };
    }
    if (request.body.includes('[sandbox:temporary]') && !this.temporaryTried.has(request.idempotencyKey)) {
      this.temporaryTried.add(request.idempotencyKey);
      return { ok: false, code: 'temporary', message: 'There was a temporary problem. It is safe to try again.' };
    }
    if (request.body.includes('[sandbox:fail]')) {
      return this.settle(request, { ok: false, code: 'rejected', message: 'The network did not accept this post. Please check it and try again.' });
    }

    const count = (this.deliveries.get(request.idempotencyKey) ?? 0) + 1;
    this.deliveries.set(request.idempotencyKey, count);
    return this.settle(request, {
      ok: true,
      externalPostId: `sandbox-${sha256Hex(request.idempotencyKey).slice(0, 12)}`,
      publishedAt: this.now().toISOString(),
    });
  }

  private settle(request: PublishRequest, result: PublishResult): PublishResult {
    this.settled.set(request.idempotencyKey, result);
    return result;
  }
}
