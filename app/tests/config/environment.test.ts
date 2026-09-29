import { describe, expect, it } from 'vitest';
import { currentEnvironment, isProduction, isStaging, liveFeaturesConceivable } from '@/lib/config/environment';

const env = (overrides: Record<string, string | undefined>) => overrides as unknown as NodeJS.ProcessEnv;

describe('currentEnvironment - APP_ENV wins, then NODE_ENV, then a safe default', () => {
  it('reads APP_ENV when it is a recognized value', () => {
    expect(currentEnvironment(env({ APP_ENV: 'staging' }))).toBe('staging');
    expect(currentEnvironment(env({ APP_ENV: 'production' }))).toBe('production');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(currentEnvironment(env({ APP_ENV: '  STAGING  ' }))).toBe('staging');
  });

  it('falls back to NODE_ENV when APP_ENV is unset', () => {
    expect(currentEnvironment(env({ NODE_ENV: 'test' }))).toBe('test');
    expect(currentEnvironment(env({ NODE_ENV: 'production' }))).toBe('production');
  });

  it('falls back to development for an unrecognized APP_ENV, never throws', () => {
    expect(currentEnvironment(env({ APP_ENV: 'not-a-real-tier' }))).toBe('development');
  });

  it('falls back to development when nothing is set', () => {
    expect(currentEnvironment(env({}))).toBe('development');
  });

  it('APP_ENV takes priority over NODE_ENV when both are set', () => {
    expect(currentEnvironment(env({ APP_ENV: 'staging', NODE_ENV: 'production' }))).toBe('staging');
  });
});

describe('isStaging / isProduction / liveFeaturesConceivable', () => {
  it('isStaging is true only in staging', () => {
    expect(isStaging(env({ APP_ENV: 'staging' }))).toBe(true);
    expect(isStaging(env({ APP_ENV: 'production' }))).toBe(false);
  });

  it('isProduction is true only in production', () => {
    expect(isProduction(env({ APP_ENV: 'production' }))).toBe(true);
    expect(isProduction(env({ APP_ENV: 'staging' }))).toBe(false);
  });

  it('liveFeaturesConceivable is true for staging and production only - never development or test', () => {
    expect(liveFeaturesConceivable(env({ APP_ENV: 'staging' }))).toBe(true);
    expect(liveFeaturesConceivable(env({ APP_ENV: 'production' }))).toBe(true);
    expect(liveFeaturesConceivable(env({ APP_ENV: 'development' }))).toBe(false);
    expect(liveFeaturesConceivable(env({ APP_ENV: 'test' }))).toBe(false);
    expect(liveFeaturesConceivable(env({}))).toBe(false);
  });
});
