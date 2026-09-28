import { describe, expect, it } from 'vitest';
import { REDACTED, auditEventForDecision, decide, scrubSecrets } from '@/lib/permissions';

describe('scrubSecrets', () => {
  it('redacts secret-looking keys at any depth, including inside arrays', () => {
    const input = {
      title: 'Connect Buffer',
      accessToken: 'abc',
      nested: { api_key: 'k', ok: 1, deeper: [{ clientSecret: 's', label: 'x' }] },
      Authorization: 'Bearer zzz',
      refresh_token: 'r',
      password: 'p',
    };
    const out = scrubSecrets(input) as Record<string, any>;
    expect(out.title).toBe('Connect Buffer');
    expect(out.accessToken).toBe(REDACTED);
    expect(out.nested.api_key).toBe(REDACTED);
    expect(out.nested.ok).toBe(1);
    expect(out.nested.deeper[0].clientSecret).toBe(REDACTED);
    expect(out.nested.deeper[0].label).toBe('x');
    expect(out.Authorization).toBe(REDACTED);
    expect(out.refresh_token).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
  });

  it('also redacts secret-looking VALUES hidden under harmless keys', () => {
    const out = scrubSecrets({
      note: 'sk_live_abcdefgh12345',
      memo: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
      detail: 'Bearer abc.def.ghi',
      repo: 'ghp_abcdefghijklmnop',
      files: ['AKIAABCDEFGHIJKLMNOP', 'a normal sentence'],
      cookie: 'anything',
      session_id: 'anything',
    }) as Record<string, any>;
    expect(out.note).toBe(REDACTED);
    expect(out.memo).toBe(REDACTED);
    expect(out.detail).toBe(REDACTED);
    expect(out.repo).toBe(REDACTED);
    expect(out.files).toEqual([REDACTED, 'a normal sentence']);
    expect(out.cookie).toBe(REDACTED);
    expect(out.session_id).toBe(REDACTED);
  });

  it('leaves ordinary text and numbers alone', () => {
    expect(scrubSecrets({ title: 'Change budget', budget: 500, mood: 'skate' })).toEqual({
      title: 'Change budget', budget: 500, mood: 'skate',
    });
  });

  it('does not mutate its input', () => {
    const input = { token: 'abc' };
    scrubSecrets(input);
    expect(input.token).toBe('abc');
  });

  it('leaves primitives and null alone', () => {
    expect(scrubSecrets(null)).toBeNull();
    expect(scrubSecrets(5)).toBe(5);
    expect(scrubSecrets('x')).toBe('x');
  });
});

describe('auditEventForDecision', () => {
  const base = { actorId: 'u1', actorRole: 'client' as const, workspaceId: 'w1' };

  it('records a denied attempt as denied', () => {
    const e = auditEventForDecision({
      ...base, module: 'paid_ads', action: 'campaign.launch',
      decision: decide({ role: 'client', grants: [] }, 'paid_ads', 'publish_execute'),
    });
    expect(e).toMatchObject({ result: 'denied', approvalStatus: null, actorId: 'u1', workspaceId: 'w1' });
  });

  it('records a sensitive action that needs approval as pending', () => {
    const e = auditEventForDecision({
      ...base, module: 'paid_ads', action: 'budget.change', approvalId: 'a1',
      decision: decide({ role: 'client', grants: [{ module: 'paid_ads', action: 'edit' }] }, 'paid_ads', 'edit'),
    });
    expect(e).toMatchObject({ result: 'pending_approval', approvalStatus: 'pending', approvalId: 'a1' });
  });

  it('scrubs secrets from metadata before they can be stored', () => {
    const e = auditEventForDecision({
      ...base, module: 'integrations', action: 'connect',
      decision: decide({ role: 'admin', grants: [] }, 'integrations', 'manage_integration'),
      metadata: { provider: 'buffer', access_token: 'live-token' },
    });
    expect(e.result).toBe('success');
    expect(e.metadata).toEqual({ provider: 'buffer', access_token: REDACTED });
  });
});
