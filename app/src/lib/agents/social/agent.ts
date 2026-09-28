/**
 * The Social Media Super Agent's own logic (Sub-phase B). One task per run, chosen by
 * `input.task`. Every capability below is scripted/deterministic - there is no AI call and no
 * network access anywhere in this file or the modules it uses.
 *
 * Every tool call that would persist something real declares `permission` (reusing the
 * EXISTING `social:create` action - nothing new) and an `apply()` that calls the store's real
 * write method. The Orchestrator (../orchestrator.ts) decides whether `apply()` may run at
 * all; this file never writes anything itself before that decision comes back.
 *
 * Publishing/sending is out of scope for Sub-phase B on purpose: there is no `publish_post` or
 * `send_reply` tool here. A draft this agent creates goes exactly as far as `in_review`
 * (pending approval) - a human takes it from there through the EXISTING Phase 3 flow,
 * unchanged.
 */

import type { Network } from '@/lib/social/types';
import type { AgentLogicResult, AgentStore, Handoff, Principal, ProposedToolCall } from '../types';
import { draftForEachNetwork } from './captions';
import { buildCalendarSlots } from './calendar';
import { createImageProvider, type ImageProvider } from './image';
import { repurposeBlogPost } from './repurpose';
import { draftReplyBody } from './replies';
import { checkBrandVoice, hasBlockingIssue } from './safety';
import { researchStrategy } from './strategy';
import type { BrandVoiceProfile } from './types';
import { draftVideoScript } from './video-script';

export type { AgentStore } from '../types';

export type SocialAgentInput =
  | { task: 'research_strategy'; topic: string; audience?: string }
  | { task: 'generate_calendar'; workspaceId: string; topic: string; audience?: string; startDate: string; days: number }
  | {
      task: 'draft_post';
      workspaceId: string;
      channelId: string;
      network: Network;
      topic: string;
      callToAction?: string;
      withImage?: boolean;
      withCarousel?: boolean;
      carouselSlides?: number;
      submitForReview?: boolean;
    }
  | {
      task: 'repurpose_blog';
      workspaceId: string;
      channels: { channelId: string; network: Network }[];
      blogTitle: string;
      blogBody: string;
      submitForReview?: boolean;
    }
  | {
      task: 'draft_reply';
      workspaceId: string;
      interactionId: string;
      interactionBody: string;
      authorHandle?: string | null;
      submitForReview?: boolean;
    }
  | { task: 'video_script'; topic: string; network: 'instagram' | 'tiktok' | 'youtube' }
  | { task: 'request_analytics'; metric: string; dateRange?: string; channelIds?: string[] }
  | { task: 'propose_lead_handoff'; interactionId: string; extractedContact?: string; confidence?: number };

async function brandVoiceIssues(store: AgentStore, workspaceId: string, text: string) {
  const profile: BrandVoiceProfile | null = (await store.getBrandVoiceProfile?.(workspaceId)) ?? null;
  return checkBrandVoice(profile, text);
}

/** A `draft_post` tool call whose `apply()` writes the real row, honouring the brand-voice gate. */
function draftPostCall(
  store: AgentStore,
  principal: Principal,
  workspaceId: string,
  channelId: string,
  body: string,
  imageAlt: string | null,
): ProposedToolCall & { getCreatedId: () => string | null } {
  let createdId: string | null = null;
  const call: ProposedToolCall = {
    toolName: 'draft_post',
    toolInput: { channelId, body, imageAlt },
    permission: { module: 'social', action: 'create' },
    apply: async () => {
      if (!store.createSocialPost) throw new Error('this store cannot create social posts');
      const { id } = await store.createSocialPost(principal, { workspaceId, channelId, body, imageAlt });
      createdId = id;
      return { postId: id };
    },
  };
  return Object.assign(call, { getCreatedId: () => createdId });
}

export async function runSocialMediaSuperAgent(input: SocialAgentInput, store: AgentStore, principal: Principal): Promise<AgentLogicResult> {
  const toolCalls: ProposedToolCall[] = [];
  const handoffs: Handoff[] = [];
  let output: Record<string, unknown> = {};

  if (input.task === 'research_strategy') {
    const pillars = researchStrategy({ topic: input.topic, audience: input.audience });
    toolCalls.push({ toolName: 'research_strategy', toolInput: { topic: input.topic } });
    output = { pillars };
  } else if (input.task === 'generate_calendar') {
    const pillars = researchStrategy({ topic: input.topic, audience: input.audience });
    const slots = buildCalendarSlots(pillars, input.startDate, input.days);
    toolCalls.push({
      toolName: 'generate_calendar',
      toolInput: { startDate: input.startDate, days: input.days, slotCount: slots.length },
      permission: { module: 'social', action: 'create' },
      apply: async () => {
        const ids: string[] = [];
        for (const slot of slots) {
          if (!store.createCalendarItem) throw new Error('this store cannot create calendar items');
          const { id } = await store.createCalendarItem(principal, {
            workspaceId: input.workspaceId,
            plannedDate: slot.plannedDate,
            theme: slot.theme,
            targetNetworks: [],
            generatedByAgent: true,
          });
          ids.push(id);
        }
        return { calendarItemIds: ids };
      },
    });
    output = { slots };
  } else if (input.task === 'draft_post') {
    const text = draftForEachNetwork(input.topic, [input.network], input.callToAction)[input.network];
    const issues = await brandVoiceIssues(store, input.workspaceId, text);
    if (hasBlockingIssue(issues)) {
      output = { blocked: true, reason: 'brand voice check failed', issues };
    } else {
      let imageAlt: string | null = null;
      if (input.withImage || input.withCarousel) {
        const provider: ImageProvider = createImageProvider();
        if (input.withCarousel) {
          const slides = Math.max(2, input.carouselSlides ?? 3);
          const results = await provider.generateCarousel(
            Array.from({ length: slides }, (_, i) => ({ prompt: `${input.topic} - slide ${i + 1}` })),
          );
          imageAlt = results.map((r) => (r.ok ? r.altText : '')).filter(Boolean).join(' | ');
        } else {
          const result = await provider.generateImage({ prompt: input.topic });
          imageAlt = result.ok ? result.altText : null;
        }
      }
      const draft = draftPostCall(store, principal, input.workspaceId, input.channelId, text, imageAlt);
      toolCalls.push(draft);
      if (input.submitForReview) {
        toolCalls.push({
          toolName: 'submit_post_for_review',
          toolInput: { channelId: input.channelId },
          permission: { module: 'social', action: 'create' },
          apply: async () => {
            const postId = draft.getCreatedId();
            if (!postId) throw new Error('the post was never created, so it cannot be submitted for review');
            if (!store.submitSocialPostForReview) throw new Error('this store cannot submit posts for review');
            await store.submitSocialPostForReview(principal, postId);
            return { postId, submitted: true };
          },
        });
      }
      output = { draftedBody: text, brandVoiceWarnings: issues };
    }
  } else if (input.task === 'repurpose_blog') {
    const perNetwork = repurposeBlogPost({ title: input.blogTitle, body: input.blogBody }, input.channels.map((c) => c.network));
    const blockedFor: Network[] = [];
    let draftedCount = 0;
    for (const { channelId, network } of input.channels) {
      const text = perNetwork[network];
      const issues = await brandVoiceIssues(store, input.workspaceId, text);
      if (hasBlockingIssue(issues)) {
        blockedFor.push(network);
        continue;
      }
      draftedCount += 1;
      const draft = draftPostCall(store, principal, input.workspaceId, channelId, text, null);
      toolCalls.push(draft);
      if (input.submitForReview) {
        toolCalls.push({
          toolName: 'submit_post_for_review',
          toolInput: { channelId },
          permission: { module: 'social', action: 'create' },
          apply: async () => {
            const postId = draft.getCreatedId();
            if (!postId) throw new Error('the post was never created, so it cannot be submitted for review');
            if (!store.submitSocialPostForReview) throw new Error('this store cannot submit posts for review');
            await store.submitSocialPostForReview(principal, postId);
            return { postId, submitted: true };
          },
        });
      }
    }
    output = { repurposedFor: input.channels.map((c) => c.network), draftedCount, blockedFor };
  } else if (input.task === 'draft_reply') {
    const body = draftReplyBody({ interactionBody: input.interactionBody, authorHandle: input.authorHandle });
    const issues = await brandVoiceIssues(store, input.workspaceId, body);
    if (hasBlockingIssue(issues)) {
      output = { blocked: true, reason: 'brand voice check failed', issues };
    } else {
      let createdId: string | null = null;
      toolCalls.push({
        toolName: 'draft_reply',
        toolInput: { interactionId: input.interactionId, body },
        permission: { module: 'social', action: 'create' },
        apply: async () => {
          if (!store.createSocialReplyDraft) throw new Error('this store cannot create reply drafts');
          const { id } = await store.createSocialReplyDraft(principal, {
            workspaceId: input.workspaceId,
            interactionId: input.interactionId,
            body,
            draftedByAgent: true,
          });
          createdId = id;
          return { replyDraftId: id };
        },
      });
      if (input.submitForReview) {
        toolCalls.push({
          toolName: 'submit_reply_for_review',
          toolInput: { interactionId: input.interactionId },
          permission: { module: 'social', action: 'create' },
          apply: async () => {
            if (!createdId) throw new Error('the reply draft was never created, so it cannot be submitted for review');
            if (!store.submitSocialReplyForReview) throw new Error('this store cannot submit reply drafts for review');
            await store.submitSocialReplyForReview(principal, createdId);
            return { replyDraftId: createdId, submitted: true };
          },
        });
      }
      output = { draftedBody: body, brandVoiceWarnings: issues };
    }
  } else if (input.task === 'video_script') {
    const script = draftVideoScript({ topic: input.topic, network: input.network });
    toolCalls.push({ toolName: 'video_script', toolInput: { topic: input.topic, network: input.network } });
    output = { script };
  } else if (input.task === 'request_analytics') {
    handoffs.push({ toAgentKey: 'analytics_reporting_agent', payload: { metric: input.metric, dateRange: input.dateRange, channelIds: input.channelIds } });
    output = { handedOff: true };
  } else if (input.task === 'propose_lead_handoff') {
    handoffs.push({
      toAgentKey: 'lead_crm_agent',
      payload: { interactionId: input.interactionId, extractedContact: input.extractedContact, confidence: input.confidence },
    });
    output = { handedOff: true };
  }

  return { output, toolCalls, handoffs };
}
