import { describe, expect, it } from 'vitest';
import { AiUsageCapExceededError, checkAiUsageCap, estimateCostUsd, evaluateAiUsageCap, recordAiCapBlockedEvent, recordAiUsage } from '@/lib/ai/usage-cap';
import type { AgentStore, AiUsageCapStatus, Principal, RecordAiUsageInput } from '@/lib/agents/types';
import type { AuditEvent } from '@/lib/permissions';

const UNLIMITED: AiUsageCapStatus = { dailyCallCap: null, monthlyCostCapUsd: null, dailyCallCount: 0, monthlyCostUsd: 0 };

describe('evaluateAiUsageCap - pure, no I/O', () => {
  it('allows when no cap is configured at all, whatever the current usage is', () => {
    expect(evaluateAiUsageCap({ ...UNLIMITED, dailyCallCount: 999999, monthlyCostUsd: 999999 })).toEqual({ allowed: true });
  });

  it('blocks once the daily call count has already reached the cap', () => {
    const result = evaluateAiUsageCap({ dailyCallCap: 5, monthlyCostCapUsd: null, dailyCallCount: 5, monthlyCostUsd: 0 });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toMatch(/daily AI usage cap/);
  });

  it('allows when strictly under the daily cap', () => {
    expect(evaluateAiUsageCap({ dailyCallCap: 5, monthlyCostCapUsd: null, dailyCallCount: 4, monthlyCostUsd: 0 })).toEqual({ allowed: true });
  });

  it('blocks once the monthly cost has already reached the cap', () => {
    const result = evaluateAiUsageCap({ dailyCallCap: null, monthlyCostCapUsd: 10, dailyCallCount: 0, monthlyCostUsd: 10 });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toMatch(/monthly AI cost cap/);
  });

  it('allows when strictly under the monthly cost cap', () => {
    expect(evaluateAiUsageCap({ dailyCallCap: null, monthlyCostCapUsd: 10, dailyCallCount: 0, monthlyCostUsd: 9.99 })).toEqual({ allowed: true });
  });

  it('the daily cap is checked even when the monthly cap is fine, and vice versa', () => {
    expect(evaluateAiUsageCap({ dailyCallCap: 2, monthlyCostCapUsd: 100, dailyCallCount: 2, monthlyCostUsd: 1 }).allowed).toBe(false);
    expect(evaluateAiUsageCap({ dailyCallCap: 100, monthlyCostCapUsd: 5, dailyCallCount: 1, monthlyCostUsd: 5 }).allowed).toBe(false);
  });
});

class FakeCapStore implements AgentStore {
  usageRecords: RecordAiUsageInput[] = [];
  auditEvents: AuditEvent[] = [];
  constructor(private status: AiUsageCapStatus | null) {}
  async findDefinition() {
    return null;
  }
  newId() {
    return 'id';
  }
  async createApprovalRequest() {
    return { id: 'a' };
  }
  async getAiUsageCapStatus() {
    if (!this.status) throw new Error('should not be called - store has no cap status configured for this test');
    return this.status;
  }
  async recordAiUsage(input: RecordAiUsageInput) {
    this.usageRecords.push(input);
  }
  async recordAuditEvent(event: AuditEvent) {
    this.auditEvents.push(event);
  }
}

class StoreWithNoCapMethods implements AgentStore {
  async findDefinition() {
    return null;
  }
  newId() {
    return 'id';
  }
  async createApprovalRequest() {
    return { id: 'a' };
  }
}

describe('checkAiUsageCap - the pre-call gate', () => {
  it('throws AiUsageCapExceededError when the store reports the cap already met', async () => {
    const store = new FakeCapStore({ dailyCallCap: 1, monthlyCostCapUsd: null, dailyCallCount: 1, monthlyCostUsd: 0 });
    await expect(checkAiUsageCap(store, 'ws-1')).rejects.toBeInstanceOf(AiUsageCapExceededError);
  });

  it('resolves cleanly when under both caps', async () => {
    const store = new FakeCapStore({ dailyCallCap: 10, monthlyCostCapUsd: 100, dailyCallCount: 1, monthlyCostUsd: 1 });
    await expect(checkAiUsageCap(store, 'ws-1')).resolves.toBeUndefined();
  });

  it('a store with no getAiUsageCapStatus() never blocks (treated as no caps configured)', async () => {
    const store = new StoreWithNoCapMethods();
    await expect(checkAiUsageCap(store, 'ws-1')).resolves.toBeUndefined();
  });
});

describe('recordAiUsage / recordAiCapBlockedEvent - the two distinct logs', () => {
  it('recordAiUsage writes to the usage log, never the audit log', async () => {
    const store = new FakeCapStore(UNLIMITED);
    await recordAiUsage(store, { workspaceId: 'ws-1', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 });
    expect(store.usageRecords).toHaveLength(1);
    expect(store.auditEvents).toHaveLength(0);
  });

  it('recordAiCapBlockedEvent writes an audit_log-shaped event, never a usage record (a blocked call has no real tokens)', async () => {
    const store = new FakeCapStore(UNLIMITED);
    const principal: Principal = { id: 'user-1', role: 'admin', grants: [] };
    await recordAiCapBlockedEvent(store, principal, 'ws-1', 'the daily AI usage cap (1 calls) has already been reached for this workspace');
    expect(store.usageRecords).toHaveLength(0);
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({ actorId: 'user-1', actorRole: 'admin', workspaceId: 'ws-1', module: 'social', action: 'ai.caption_blocked', result: 'denied' });
    expect(store.auditEvents[0].metadata).toMatchObject({ reason: expect.stringContaining('daily AI usage cap') });
  });

  it('both are no-ops (never throw) against a store that implements neither', async () => {
    const store = new StoreWithNoCapMethods();
    const principal: Principal = { id: 'user-1', role: 'admin', grants: [] };
    await expect(recordAiUsage(store, { workspaceId: 'ws-1', provider: 'anthropic', model: 'x', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 })).resolves.toBeUndefined();
    await expect(recordAiCapBlockedEvent(store, principal, 'ws-1', 'reason')).resolves.toBeUndefined();
  });
});

describe('estimateCostUsd', () => {
  it('computes a positive cost for a known model', () => {
    const cost = estimateCostUsd('claude-sonnet-5-5', 1_000_000, 1_000_000);
    expect(cost).toBeGreaterThan(0);
  });

  it('scales linearly with token count', () => {
    const small = estimateCostUsd('claude-sonnet-5-5', 100, 50);
    const large = estimateCostUsd('claude-sonnet-5-5', 1000, 500);
    expect(large).toBeCloseTo(small * 10, 10);
  });

  it('falls back to a default price table for an unrecognized model, never throws', () => {
    expect(() => estimateCostUsd('some-future-model-not-yet-priced', 100, 100)).not.toThrow();
    expect(estimateCostUsd('some-future-model-not-yet-priced', 100, 100)).toBeGreaterThan(0);
  });

  it('zero tokens costs zero', () => {
    expect(estimateCostUsd('claude-sonnet-5-5', 0, 0)).toBe(0);
  });
});
