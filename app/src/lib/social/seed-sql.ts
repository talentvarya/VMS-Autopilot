import { NETWORKS } from './types';
import { NETWORK_LIMITS } from './networks';

export const SOCIAL_SEED_FILE = 'supabase/migrations/20260928000600_social_limits_seed.sql';

/** The per-network limits table, generated from TypeScript so SQL and TypeScript cannot disagree. */
export function renderSocialSeedSql(): string {
  const rows = NETWORKS.map((n) => `  ('${n}', ${NETWORK_LIMITS[n].maxChars})`);
  return [
    '-- GENERATED FILE - DO NOT EDIT BY HAND.',
    '-- Source of truth: src/lib/social/networks.ts',
    '-- Regenerate with: npm run gen:social',
    '-- A test fails if this file is out of date.',
    '',
    'begin;',
    '',
    'delete from public.social_network_limits;',
    'insert into public.social_network_limits (network, max_chars) values',
    rows.join(',\n') + ';',
    '',
    'commit;',
    '',
  ].join('\n');
}
