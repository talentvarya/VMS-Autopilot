import type {
  AgentDefinition,
  AgentStore,
  ApprovalRequestInput,
  CreateCalendarItemInput,
  CreateSocialPostInput,
  CreateSocialReplyDraftInput,
  Principal,
} from '@/lib/agents/types';
import type { BrandVoiceProfile } from '@/lib/agents/social/types';
import { SocialStore } from '@/lib/social/store';

/**
 * A test-only AgentStore backed by the REAL Phase 3 `SocialStore` for posts - so a test that
 * runs the Social Media Super Agent through this store is proving the exact same claim the
 * dashboard's own "New Post" flow already relies on: a post created here is a real, rule-
 * checked draft (length limits, empty-body checks, daily limits, channel status), not a
 * separate, parallel implementation invented for agents.
 *
 * Reply drafts, calendar items and brand voice are simple in-memory records for this phase -
 * there is no equivalent Phase-3 business-rule class for them yet to delegate to.
 */
export class SocialAgentFixtureStore implements AgentStore {
  readonly socialStore: SocialStore;
  definitions: AgentDefinition[];
  approvals: ApprovalRequestInput[] = [];
  calendarItems: (CreateCalendarItemInput & { id: string })[] = [];
  replyDrafts: (CreateSocialReplyDraftInput & { id: string; status: 'drafted' | 'in_review' })[] = [];
  brandVoice: BrandVoiceProfile | null = null;
  private n = 0;

  constructor(definitions: AgentDefinition[], socialStore: SocialStore) {
    this.definitions = definitions;
    this.socialStore = socialStore;
  }

  async findDefinition(workspaceId: string, agentKey: string) {
    return this.definitions.find((d) => d.workspaceId === workspaceId && d.agentKey === agentKey) ?? null;
  }
  newId() {
    return `run-${++this.n}`;
  }
  async createApprovalRequest(input: ApprovalRequestInput) {
    this.approvals.push(input);
    return { id: `approval-${this.approvals.length}` };
  }

  async createSocialPost(principal: Principal, input: CreateSocialPostInput) {
    const result = this.socialStore.createDraft(principal, {
      channelId: input.channelId,
      body: input.body,
      imageAlt: input.imageAlt ?? undefined,
      groupId: input.groupId ?? undefined,
    });
    if (!result.ok) throw new Error(result.message);
    return { id: result.value.id };
  }

  async submitSocialPostForReview(principal: Principal, postId: string) {
    const result = this.socialStore.transition(principal, postId, 'in_review');
    if (!result.ok) throw new Error(result.message);
  }

  async createSocialReplyDraft(_principal: Principal, input: CreateSocialReplyDraftInput) {
    const id = `reply-${this.replyDrafts.length + 1}`;
    this.replyDrafts.push({ ...input, id, status: 'drafted' });
    return { id };
  }

  async submitSocialReplyForReview(_principal: Principal, draftId: string) {
    const draft = this.replyDrafts.find((r) => r.id === draftId);
    if (!draft) throw new Error('that reply draft does not exist');
    draft.status = 'in_review';
  }

  async createCalendarItem(_principal: Principal, input: CreateCalendarItemInput) {
    const id = `cal-${this.calendarItems.length + 1}`;
    this.calendarItems.push({ ...input, id });
    return { id };
  }

  async getBrandVoiceProfile() {
    return this.brandVoice;
  }
}
