import { describe, expect, it } from 'vitest';
import { validateEnvironment, type EnvVarSpec } from '@/lib/config/env-validation';
import { STAGING_ENV_SPEC } from '@/lib/config/staging-env-spec';

const env = (overrides: Record<string, string | undefined>) => overrides as unknown as NodeJS.ProcessEnv;

const SPEC: readonly EnvVarSpec[] = [
  { name: 'REQUIRED_URL', required: true, shape: { kind: 'url' }, purpose: 'test' },
  { name: 'REQUIRED_NONEMPTY', required: true, shape: { kind: 'nonEmpty' }, purpose: 'test' },
  { name: 'OPTIONAL_PATTERNED', required: false, shape: { kind: 'pattern', pattern: /^sk-ant-/, description: 'starts with sk-ant-' }, purpose: 'test' },
];

describe('validateEnvironment - presence and shape only, never the value', () => {
  it('passes when every required var is present with a valid shape, optional var absent', () => {
    const report = validateEnvironment(SPEC, env({ REQUIRED_URL: 'https://example.test', REQUIRED_NONEMPTY: 'anything' }));
    expect(report.ok).toBe(true);
    expect(report.results.find((r) => r.name === 'OPTIONAL_PATTERNED')).toMatchObject({ present: false, validShape: null, problem: null });
  });

  it('fails when a required var is missing, and says so without ever naming a value', () => {
    const report = validateEnvironment(SPEC, env({}));
    expect(report.ok).toBe(false);
    const missing = report.results.find((r) => r.name === 'REQUIRED_URL');
    expect(missing).toMatchObject({ present: false, problem: 'is required but not set' });
  });

  it('fails a URL-shaped var that is not a URL', () => {
    const report = validateEnvironment(SPEC, env({ REQUIRED_URL: 'not a url at all', REQUIRED_NONEMPTY: 'x' }));
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.name === 'REQUIRED_URL')).toMatchObject({ present: true, validShape: false, problem: 'is not a valid URL' });
  });

  it('fails a nonEmpty var that is set but blank', () => {
    const report = validateEnvironment(SPEC, env({ REQUIRED_URL: 'https://example.test', REQUIRED_NONEMPTY: '   ' }));
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.name === 'REQUIRED_NONEMPTY')?.problem).toBe('is set but empty');
  });

  it('fails a present optional var with the wrong shape, even though absence would be fine', () => {
    const report = validateEnvironment(
      SPEC,
      env({ REQUIRED_URL: 'https://example.test', REQUIRED_NONEMPTY: 'x', OPTIONAL_PATTERNED: 'totally-wrong-shape' }),
    );
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.name === 'OPTIONAL_PATTERNED')?.problem).toMatch(/does not match the expected shape/);
  });

  it('passes a present optional var with the right shape', () => {
    const report = validateEnvironment(
      SPEC,
      env({ REQUIRED_URL: 'https://example.test', REQUIRED_NONEMPTY: 'x', OPTIONAL_PATTERNED: 'sk-ant-obviously-fake-test-value' }),
    );
    expect(report.ok).toBe(true);
  });

  it('never includes the actual value anywhere in the report, valid or not', () => {
    const secretLookingValue = 'sk-ant-THIS-MUST-NEVER-APPEAR-IN-THE-REPORT';
    const report = validateEnvironment(SPEC, env({ REQUIRED_URL: 'https://example.test', REQUIRED_NONEMPTY: 'x', OPTIONAL_PATTERNED: secretLookingValue }));
    expect(JSON.stringify(report)).not.toContain(secretLookingValue);
  });
});

describe('STAGING_ENV_SPEC - the real staging shape list, checked with obviously-fake test values', () => {
  it('is incomplete (fails) with none of the required vars set', () => {
    const report = validateEnvironment(STAGING_ENV_SPEC, env({}));
    expect(report.ok).toBe(false);
    expect(report.results.filter((r) => r.problem).length).toBeGreaterThan(0);
  });

  it('passes core requirements with fake-but-shaped values, AI/Meta vars left unset', () => {
    const report = validateEnvironment(
      STAGING_ENV_SPEC,
      env({
        APP_ENV: 'staging',
        NEXT_PUBLIC_SUPABASE_URL: 'https://fake-staging-project.supabase.test',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key-for-test-only',
        SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key-for-test-only',
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.results.find((r) => r.name === 'ANTHROPIC_API_KEY')).toMatchObject({ present: false, problem: null });
    expect(report.results.find((r) => r.name === 'META_APP_ID')).toMatchObject({ present: false, problem: null });
  });

  it('rejects an ANTHROPIC_API_KEY that does not start with sk-ant- (a clearly-fake value in the wrong shape)', () => {
    const report = validateEnvironment(
      STAGING_ENV_SPEC,
      env({
        APP_ENV: 'staging',
        NEXT_PUBLIC_SUPABASE_URL: 'https://fake-staging-project.supabase.test',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key-for-test-only',
        SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key-for-test-only',
        ANTHROPIC_API_KEY: 'totally-wrong-prefix-fake-value',
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.name === 'ANTHROPIC_API_KEY')?.problem).toMatch(/does not match the expected shape/);
  });
});
