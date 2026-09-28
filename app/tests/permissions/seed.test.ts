import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CEILING_ROWS, DEFAULT_ROWS, SENSITIVE_ROWS } from '@/lib/permissions';
import { SEED_FILE, renderPermissionSeedSql } from '@/lib/permissions/seed-sql';

describe('generated SQL seed', () => {
  it('matches the committed migration file exactly (run `npm run gen:permissions` if this fails)', () => {
    const committed = readFileSync(resolve(__dirname, '..', '..', SEED_FILE), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderPermissionSeedSql());
  });

  it('has sensible sizes', () => {
    expect(CEILING_ROWS.length).toBeGreaterThan(50);
    expect(DEFAULT_ROWS.length).toBeGreaterThan(5);
    expect(DEFAULT_ROWS.length).toBeLessThan(CEILING_ROWS.length);
    expect(SENSITIVE_ROWS.length).toBeGreaterThan(20);
  });
});
