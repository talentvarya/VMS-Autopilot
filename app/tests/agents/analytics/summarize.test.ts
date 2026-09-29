import { describe, expect, it } from 'vitest';
import { runAnalyticsAgent } from '@/lib/agents/analytics/agent';

describe('runAnalyticsAgent - valid task-shaped input', () => {
  it('summarize_seo_performance averages scores and reports the latest run', async () => {
    const result = await runAnalyticsAgent({ task: 'summarize_seo_performance', auditRuns: [{ overallScore: 60, categoryScores: {} }, { overallScore: 80, categoryScores: {} }] });
    expect(result.output).toMatchObject({ averageScore: 70, runCount: 2 });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].permission).toEqual({ module: 'reports', action: 'view' });
    expect(result.toolCalls[0].apply).toBeUndefined();
  });

  it('summarize_social_activity counts by status and network', async () => {
    const result = await runAnalyticsAgent({ task: 'summarize_social_activity', posts: [{ status: 'published', network: 'facebook' }, { status: 'draft', network: 'facebook' }, { status: 'published', network: 'x' }] });
    expect(result.output).toMatchObject({ byStatus: { published: 2, draft: 1 }, byNetwork: { facebook: 2, x: 1 }, total: 3 });
  });

  it('summarize_content_pipeline and summarize_agent_activity count correctly', async () => {
    const content = await runAnalyticsAgent({ task: 'summarize_content_pipeline', drafts: [{ status: 'draft' }, { status: 'approved' }] });
    expect(content.output).toMatchObject({ byStatus: { draft: 1, approved: 1 }, total: 2 });

    const activity = await runAnalyticsAgent({ task: 'summarize_agent_activity', runs: [{ agentKey: 'seo_geo_agent', status: 'succeeded' }, { agentKey: 'seo_geo_agent', status: 'failed' }] });
    expect(activity.output).toMatchObject({ byAgent: { seo_geo_agent: 2 }, byStatus: { succeeded: 1, failed: 1 } });
  });

  it('compile_report assembles sections into one document', async () => {
    const result = await runAnalyticsAgent({ task: 'compile_report', sections: [{ title: 'SEO', summary: 'All good.' }] });
    expect(result.output.report).toContain('## SEO');
    expect(result.output.report).toContain('All good.');
  });
});

describe('runAnalyticsAgent - never writes anything, structurally', () => {
  it('no tool call ever defines apply(), for any task', async () => {
    const tasks = [
      { task: 'summarize_seo_performance', auditRuns: [] },
      { task: 'summarize_social_activity', posts: [] },
      { task: 'summarize_content_pipeline', drafts: [] },
      { task: 'summarize_agent_activity', runs: [] },
      { task: 'compile_report', sections: [] },
    ];
    for (const input of tasks) {
      const result = await runAnalyticsAgent(input);
      expect(result.toolCalls.every((c) => c.apply === undefined)).toBe(true);
      expect(result.handoffs).toEqual([]);
    }
  });
});

describe('the legacy request_analytics compatibility rule (Sub-phase B)', () => {
  it('maps a valid legacy payload (metric + dateRange + channelIds, no task) to summarize_social_activity', async () => {
    const result = await runAnalyticsAgent({ metric: 'engagement_rate', dateRange: 'last_30_days', channelIds: ['chan-1'], posts: [{ status: 'published', network: 'facebook' }] });
    expect(result.toolCalls[0].toolName).toBe('summarize_social_activity');
    expect(result.toolCalls[0].toolInput).toMatchObject({ metric: 'engagement_rate', dateRange: 'last_30_days', channelIds: ['chan-1'] });
    expect(result.output).toMatchObject({ total: 1 });
  });

  it('rejects a legacy-shaped payload missing dateRange', async () => {
    await expect(runAnalyticsAgent({ metric: 'engagement_rate', channelIds: ['chan-1'] })).rejects.toThrow(/metric, dateRange and channelIds/);
  });

  it('rejects a legacy-shaped payload missing channelIds', async () => {
    await expect(runAnalyticsAgent({ metric: 'engagement_rate', dateRange: 'last_30_days' })).rejects.toThrow(/metric, dateRange and channelIds/);
  });

  it('rejects an object with neither a task nor a metric', async () => {
    await expect(runAnalyticsAgent({ somethingElse: true })).rejects.toThrow(/not a recognizable request_analytics handoff/);
  });
});

describe('malformed or unknown payloads are rejected outright', () => {
  it('rejects a non-object input', async () => {
    await expect(runAnalyticsAgent('just a string')).rejects.toThrow(/needs an object/);
    await expect(runAnalyticsAgent(null)).rejects.toThrow(/needs an object/);
  });

  it('rejects an unknown task name', async () => {
    await expect(runAnalyticsAgent({ task: 'delete_everything' })).rejects.toThrow(/unknown Analytics Agent task/);
  });

  it('rejects a known task with the wrong shape', async () => {
    await expect(runAnalyticsAgent({ task: 'summarize_seo_performance', auditRuns: 'not an array' })).rejects.toThrow(/needs an "auditRuns" array/);
    await expect(runAnalyticsAgent({ task: 'summarize_social_activity' })).rejects.toThrow(/needs a "posts" array/);
  });
});
