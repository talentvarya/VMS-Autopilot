/**
 * The Content Agent's own logic (Sub-phase C). One task: draft_article. It may only ever
 * create an article draft and, when explicitly asked, submit it for review - it has NO tool
 * that approves or publishes anything (see the guardrails recorded in
 * supabase/migrations/20260929000300_content_agent.sql). Publishing stays Admin-only because
 * there is, structurally, no publish path here at all yet.
 */

import type { Network } from '@/lib/social/types';
import type { AgentLogicResult, AgentStore, Handoff, Principal, ProposedToolCall } from '../types';

export type ContentAgentInput = {
  task: 'draft_article';
  workspaceId: string;
  title: string;
  topic: string;
  sourceFindingId?: string | null;
  submitForReview?: boolean;
  /**
   * Only ever set by the ORIGINAL caller's own explicit request (a human, or the SEO/GEO
   * Agent forwarding what a human asked for via content_brief_handoff) - this agent never
   * decides on its own to cascade into social. "Do not auto-trigger social repurposing for
   * every article unless the workflow explicitly requests it."
   */
  alsoRepurposeToSocial?: boolean;
  repurposeChannels?: { channelId: string; network: Network }[];
};

function draftArticleBody(title: string, topic: string): string {
  return `${title}\n\n${topic}\n\nThis article was drafted from the topic above and is ready for review before anything is published.`;
}

export async function runContentAgent(input: ContentAgentInput, store: AgentStore, principal: Principal): Promise<AgentLogicResult> {
  const toolCalls: ProposedToolCall[] = [];
  const handoffs: Handoff[] = [];
  const body = draftArticleBody(input.title, input.topic);
  let createdId: string | null = null;

  toolCalls.push({
    toolName: 'draft_article',
    toolInput: { title: input.title, sourceFindingId: input.sourceFindingId ?? null },
    permission: { module: 'seo_geo', action: 'create' },
    apply: async () => {
      if (!store.createContentDraft) throw new Error('this store cannot create content drafts');
      const { id } = await store.createContentDraft(principal, {
        workspaceId: input.workspaceId,
        title: input.title,
        body,
        sourceFindingId: input.sourceFindingId ?? null,
        draftedByAgent: true,
      });
      createdId = id;
      return { draftId: id };
    },
  });

  if (input.submitForReview) {
    toolCalls.push({
      toolName: 'submit_article_for_review',
      toolInput: {},
      permission: { module: 'seo_geo', action: 'create' },
      apply: async () => {
        if (!createdId) throw new Error('the article was never created, so it cannot be submitted for review');
        if (!store.submitContentDraftForReview) throw new Error('this store cannot submit content drafts for review');
        await store.submitContentDraftForReview(principal, createdId);
        return { draftId: createdId, submitted: true };
      },
    });
  }

  if (input.alsoRepurposeToSocial && input.repurposeChannels && input.repurposeChannels.length > 0) {
    handoffs.push({
      toAgentKey: 'social_media_super_agent',
      payload: {
        task: 'repurpose_blog',
        workspaceId: input.workspaceId,
        channels: input.repurposeChannels,
        blogTitle: input.title,
        blogBody: body,
      },
    });
  }

  return { output: { draftedBody: body }, toolCalls, handoffs };
}
