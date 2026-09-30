import { liveFeaturesConceivable } from '@/lib/config/environment';
import { FIXTURE_SITES, type FixtureSite } from './fixtures';
import { fetchLiveSnapshot } from './live-fetch';
import type { AuditSource, SiteSnapshot } from './types';

/**
 * Where website snapshots come from.
 *
 * Phase G.16 - live fetching is approved and built (live-fetch.ts), behind the SAME layered
 * gate every other real-provider feature in this app uses: a compile-time flag AND an
 * environment-tier check (liveFeaturesConceivable() - development and test can never reach a
 * live fetch, no matter what this flag says). SSRF protection (safe-url.ts + live-fetch.ts's own
 * DNS-pinning) is a separate, always-on concern - it applies regardless of which gate gets
 * changed later.
 */

export interface SnapshotSource {
  readonly kind: AuditSource;
  getSnapshot(origin: string): Promise<SiteSnapshot>;
}

/** Fixed at build time. Changing it is a code change that must be reviewed, not a setting. */
export const LIVE_AUDITS_ENABLED = true as const;

export class LiveAuditsDisabledError extends Error {
  constructor() {
    super('Live website audits are switched off in this environment.');
    this.name = 'LiveAuditsDisabledError';
  }
}

export class UnknownSampleSiteError extends Error {
  constructor(origin: string) {
    super(`"${origin}" is not one of the built-in sample sites.`);
    this.name = 'UnknownSampleSiteError';
  }
}

const normalise = (origin: string) => origin.trim().toLowerCase().replace(/\/+$/, '');

export class FixtureSource implements SnapshotSource {
  readonly kind = 'fixture' as const;
  constructor(private readonly sites: readonly FixtureSite[] = FIXTURE_SITES) {}

  async getSnapshot(origin: string): Promise<SiteSnapshot> {
    const site = this.sites.find((s) => normalise(s.origin) === normalise(origin));
    if (!site) throw new UnknownSampleSiteError(origin);
    return structuredClone(site.snapshot);
  }
}

export class LiveSource implements SnapshotSource {
  readonly kind = 'live' as const;

  async getSnapshot(origin: string): Promise<SiteSnapshot> {
    return fetchLiveSnapshot(origin);
  }
}

export function createSource(kind: AuditSource, overrides?: { liveEnabled?: boolean; env?: NodeJS.ProcessEnv }): SnapshotSource {
  if (kind === 'fixture') return new FixtureSource();
  const liveEnabled = overrides?.liveEnabled ?? LIVE_AUDITS_ENABLED;
  if (!liveEnabled) throw new LiveAuditsDisabledError();
  if (!liveFeaturesConceivable(overrides?.env)) throw new LiveAuditsDisabledError();
  return new LiveSource();
}
