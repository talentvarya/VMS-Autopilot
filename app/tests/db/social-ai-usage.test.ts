import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@/lib/agents/orchestrator';
import { generateCaptionText } from '@/lib/agents/social/agent';
import type { CaptionAiRequest, CaptionAiResult, CaptionProvider } from '@/lib/agents/social/caption-ai-provider';
import { AiUsageCapExceededError } from '@/lib/ai/usage-cap';
import { SocialStore } from '@/lib/social/store';
import { SeoContentSocialFixtureStore } from './agent-fixtures';
import { ID, asOwner, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * Phase F.2: the AI usage cap pre-check, usage logging, and blocked-event audit logging,
 * proven against REAL Postgres rows (ai_usage_log / workspace_settings / audit_log, all from
 * Phase F.1's own migration and foundation_schema.sql). generateCaptionText() is called with a
 * fake 'anthropic'-kind provider (providerOverride) - the only way to exercise the real-path
 * wiring while LIVE_SOCIAL_CAPTION_AI_ENABLED stays committed as false; production code never
 * passes an override (see tests/agents/social/caption-ai-provider.test.ts).
 */

let db: Db;
beforeAll(async () => {
  db = await createDb();
  await seedFixture(db);
});
afterAll(async () => {
  await db.close();
});
useRollbackPerTest(() => db);

const asAdmin = <T,>(fn: () => Promise<T>) => asUser(db, ID.agencyAdmin, fn);
const admin = (): Principal => ({ id: ID.agencyAdmin, role: 'admin', grants: [] });

function makeStore() {
  const socialStore = new SocialStore({ now: () => new Date('2026-10-05T12:00:00.000Z'), plan: { tier: 'free', name: 'Free (test)', channelLimit: 5 }, channels: [] });
  return new SeoContentSocialFixtureStore([], db, socialStore);
}

const fakeProvider = (result: CaptionAiResult): CaptionProvider => ({
  kind: 'anthropic',
  generateCaption: async (_request: CaptionAiRequest) => result,
});

describe('a real call under the cap writes a genuine ai_usage_log row', () => {
  it('records real token counts and a positive estimated cost', async () => {
    const store = makeStore();
    const text = await generateCaptionText(store, admin(), ID.nova, 'facebook', 'Our spring menu', undefined, fakeProvider({ text: 'a real caption', inputTokens: 150, outputTokens: 60 }));
    expect(text).toBe('a real caption');
    const [row] = await asOwner(db, () => rows<any>(db, `select provider, model, input_tokens, output_tokens, estimated_cost_usd from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(row).toBeTruthy();
    expect(row.provider).toBe('anthropic');
    expect(row.input_tokens).toBe(150);
    expect(row.output_tokens).toBe(60);
    expect(Number(row.estimated_cost_usd)).toBeGreaterThan(0);
  });
});

describe('a workspace already at its real, database-stored daily cap refuses the call entirely', () => {
  it('throws AiUsageCapExceededError, the fake provider is never called, no usage row is written', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ai_daily_call_cap = 1 where workspace_id = $1`, [ID.nova]));
    // One call already logged today, via the real service-role path.
    const store = makeStore();
    await generateCaptionText(store, admin(), ID.nova, 'facebook', 'First', undefined, fakeProvider({ text: 'one', inputTokens: 10, outputTokens: 5 }));

    let threw: unknown;
    try {
      await generateCaptionText(store, admin(), ID.nova, 'facebook', 'Second', undefined, fakeProvider({ text: 'two', inputTokens: 10, outputTokens: 5 }));
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(AiUsageCapExceededError);

    const usageRows = await asOwner(db, () => rows<any>(db, `select id from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(usageRows).toHaveLength(1); // only the first call, never a second

    const auditRows = await asOwner(db, () => rows<any>(db, `select result, action, metadata from public.audit_log where workspace_id = $1 and action = 'ai.caption_blocked'`, [ID.nova]));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].result).toBe('denied');
  });
});

describe('a workspace already at its real, database-stored monthly cost cap refuses the call entirely', () => {
  it('the app-level pre-check blocks BEFORE any real call, once the running total already meets the cap', async () => {
    // ai_monthly_cost_cap_usd is numeric(12,2), so every number here is chosen to round
    // cleanly to cents. 10000 input + 0 output tokens at the configured pricing costs exactly
    // $0.03 - a cap set to that same value means the first call is allowed (not yet AT the
    // cap) and the second is refused by the pre-check itself, never reaching the fake provider.
    await asAdmin(() => db.query(`update public.workspace_settings set ai_monthly_cost_cap_usd = 0.03 where workspace_id = $1`, [ID.nova]));
    const store = makeStore();
    await generateCaptionText(store, admin(), ID.nova, 'facebook', 'First', undefined, fakeProvider({ text: 'one', inputTokens: 10000, outputTokens: 0 }));

    const secondProvider = fakeProvider({ text: 'two', inputTokens: 10000, outputTokens: 0 });
    let callCount = 0;
    const countingProvider = { kind: 'anthropic' as const, generateCaption: async (r: Parameters<typeof secondProvider.generateCaption>[0]) => { callCount += 1; return secondProvider.generateCaption(r); } };
    await expect(
      generateCaptionText(store, admin(), ID.nova, 'facebook', 'Second', undefined, countingProvider),
    ).rejects.toBeInstanceOf(AiUsageCapExceededError);
    expect(callCount).toBe(0); // the pre-check refused before the provider was ever called

    const [{ count }] = await asOwner(db, () => rows<{ count: string }>(db, `select count(*)::text as count from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(Number(count)).toBe(1); // only the first, successful call was ever logged
  });

  it('the database trigger is the exact per-call backstop for the boundary the pre-check cannot see in advance', async () => {
    // The pre-check only looks at the total ALREADY at/over the cap - it cannot know a call's
    // own exact cost before the provider responds. Two calls whose individual costs are each
    // under the cap, but whose SUM crosses it, pass the pre-check both times but the second
    // insert is refused by Phase F.1's own database trigger - after the real call already
    // happened, which is exactly why this is audited here too (see agent.ts's try/catch around
    // recordAiUsage), not silently dropped.
    await asAdmin(() => db.query(`update public.workspace_settings set ai_monthly_cost_cap_usd = 0.05 where workspace_id = $1`, [ID.nova]));
    const store = makeStore();
    await generateCaptionText(store, admin(), ID.nova, 'facebook', 'First', undefined, fakeProvider({ text: 'one', inputTokens: 10000, outputTokens: 0 }));

    await expect(
      generateCaptionText(store, admin(), ID.nova, 'facebook', 'Second', undefined, fakeProvider({ text: 'two', inputTokens: 10000, outputTokens: 0 })),
    ).rejects.toThrow(/monthly AI cost cap/);

    const [{ count }] = await asOwner(db, () => rows<{ count: string }>(db, `select count(*)::text as count from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(Number(count)).toBe(1); // the second call's row was refused, never landed
    const auditRows = await asOwner(db, () => rows<any>(db, `select result from public.audit_log where workspace_id = $1 and action = 'ai.caption_blocked'`, [ID.nova]));
    expect(auditRows).toHaveLength(1); // the boundary rejection is audited too, not just pre-check blocks
  });
});

describe('caps are per-workspace - one workspace being capped never blocks another', () => {
  it('nova at its cap does not affect bright', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ai_daily_call_cap = 0 where workspace_id = $1`, [ID.nova]));
    const store = makeStore();
    await expect(
      generateCaptionText(store, admin(), ID.nova, 'facebook', 'Topic', undefined, fakeProvider({ text: 'x', inputTokens: 1, outputTokens: 1 })),
    ).rejects.toBeInstanceOf(AiUsageCapExceededError);

    const text = await generateCaptionText(store, admin(), ID.bright, 'facebook', 'Topic', undefined, fakeProvider({ text: 'bright caption', inputTokens: 1, outputTokens: 1 }));
    expect(text).toBe('bright caption');
  });
});

describe('a NULL cap (never configured) means unlimited, matching every other cap column in this project', () => {
  it('several real calls succeed with no cap columns set', async () => {
    const store = makeStore();
    for (let i = 0; i < 3; i += 1) {
      await generateCaptionText(store, admin(), ID.nova, 'facebook', `Topic ${i}`, undefined, fakeProvider({ text: `caption ${i}`, inputTokens: 10, outputTokens: 10 }));
    }
    const [{ count }] = await asOwner(db, () => rows<{ count: string }>(db, `select count(*)::text as count from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(Number(count)).toBe(3);
  });
});
