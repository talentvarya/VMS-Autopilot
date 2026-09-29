/**
 * Content Agent (Sub-phase C) - shared vocabulary. Mirrors the table in
 * supabase/migrations/20260929000300_content_agent.sql.
 */

export const CONTENT_DRAFT_STATUSES = ['draft', 'in_review', 'approved', 'cancelled'] as const;
export type ContentDraftStatus = (typeof CONTENT_DRAFT_STATUSES)[number];

export interface ContentDraft {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  status: ContentDraftStatus;
  sourceFindingId: string | null;
  draftedByAgent: boolean;
  createdBy: string | null;
  approvedBy: string | null;
  approvedHash: string | null;
}
