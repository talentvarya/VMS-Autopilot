import { describe, expect, it } from 'vitest';
import { CONTENT_DRAFT_EDITABLE, contentDraftCanTransition, contentDraftHash, contentDraftRequirementFor } from '@/lib/agents/content/state';
import { CONTENT_DRAFT_STATUSES } from '@/lib/agents/content/types';

describe('content draft state machine', () => {
  it('has a rule for every pair of statuses, and only the intended moves are legal', () => {
    const legal = new Set(['draft>in_review', 'draft>cancelled', 'in_review>draft', 'in_review>approved', 'in_review>cancelled', 'approved>draft', 'approved>cancelled']);
    for (const from of CONTENT_DRAFT_STATUSES) {
      for (const to of CONTENT_DRAFT_STATUSES) {
        expect(contentDraftCanTransition(from, to), `${from} -> ${to}`).toBe(legal.has(`${from}>${to}`));
      }
    }
  });

  it('requires "approve" to move from in_review to approved - never something an agent can do on its own', () => {
    expect(contentDraftRequirementFor('in_review', 'approved')).toEqual(['approve']);
  });

  it('there is no "published" status at all', () => {
    expect(CONTENT_DRAFT_STATUSES).not.toContain('published');
  });

  it('cancelled is a dead end', () => {
    for (const to of CONTENT_DRAFT_STATUSES) expect(contentDraftCanTransition('cancelled', to)).toBe(false);
  });

  it('an approved draft can still be edited (which sends it back to draft)', () => {
    expect(CONTENT_DRAFT_EDITABLE).toContain('approved');
  });
});

describe('contentDraftHash', () => {
  it('changes when the title or the body changes', () => {
    const base = contentDraftHash('Title', 'Body');
    expect(contentDraftHash('Title', 'Body')).toBe(base);
    expect(contentDraftHash('Different title', 'Body')).not.toBe(base);
    expect(contentDraftHash('Title', 'Different body')).not.toBe(base);
  });

  it('looks like a SHA-256 hex digest', () => {
    expect(contentDraftHash('a', 'b')).toMatch(/^[0-9a-f]{64}$/);
  });
});
