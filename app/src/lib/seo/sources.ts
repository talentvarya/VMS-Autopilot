import { FIXTURE_SITES, type FixtureSite } from './fixtures';
import type { AuditSource, SiteSnapshot } from './types';

/**
 * Where website snapshots come from.
 *
 * Phase 2: ONLY built-in sample sites. Live fetching is switched off - by design and by test -
 * until the owner approves real integrations.
 */

export interface SnapshotSource {
  readonly kind: AuditSource;
  getSnapshot(origin: string): Promise<SiteSnapshot>;
}

/** Fixed at build time. Changing it is a code change that must be reviewed, not a setting. */
export const LIVE_AUDITS_ENABLED = false as const;

export class LiveAuditsDisabledError extends Error {
  constructor() {
    super('Live website audits are switched off. Only the built-in sample sites can be audited until real integrations are approved.');
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

export function createSource(kind: AuditSource): SnapshotSource {
  if (kind === 'fixture') return new FixtureSource();
  // Even if this constant were edited, the live source does not exist yet.
  if (!LIVE_AUDITS_ENABLED) throw new LiveAuditsDisabledError();
  throw new LiveAuditsDisabledError();
}
