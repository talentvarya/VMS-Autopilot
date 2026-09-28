import { CEILING_ROWS, DEFAULT_ROWS, SENSITIVE_ROWS } from './policy';

export const SEED_FILE = 'supabase/migrations/20260928000300_permission_seed.sql';

const tuple = (cells: readonly string[]) => `  (${cells.map((c) => `'${c}'`).join(', ')})`;

/**
 * Render the permission lookup-table seed exactly as it is committed to
 * SEED_FILE. Generated from policy.ts so SQL and TypeScript cannot disagree.
 */
export function renderPermissionSeedSql(): string {
  const block = (table: string, columns: string, rows: readonly (readonly string[])[]) =>
    [
      `delete from public.${table};`,
      `insert into public.${table} (${columns}) values`,
      rows.map(tuple).join(',\n') + ';',
    ].join('\n');

  return [
    '-- GENERATED FILE - DO NOT EDIT BY HAND.',
    '-- Source of truth: src/lib/permissions/policy.ts',
    '-- Regenerate with: npm run gen:permissions',
    '-- A test fails if this file is out of date.',
    '--',
    '-- Admin is not listed: Admin can do everything in a workspace they administer.',
    '',
    'begin;',
    '',
    '-- The most each role can ever hold. Admin grants can never exceed this.',
    block('permission_ceiling', 'role, module, action', CEILING_ROWS),
    '',
    '-- What each role holds before any Admin grant.',
    block('permission_defaults', 'role, module, action', DEFAULT_ROWS),
    '',
    '-- Sensitive actions: always audited; a non-admin who is allowed to do one must get approval.',
    block('permission_sensitive', 'module, action', SENSITIVE_ROWS),
    '',
    'commit;',
    '',
  ].join('\n');
}
