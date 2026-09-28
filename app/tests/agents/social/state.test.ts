import { describe, expect, it } from 'vitest';
import { REPLY_EDITABLE, replyCanTransition, replyContentHash, replyRequirementFor } from '@/lib/agents/social/state';
import { REPLY_STATUSES } from '@/lib/agents/social/types';

describe('reply state machine', () => {
  it('has a rule for every pair of statuses, and only the intended moves are legal', () => {
    const legal = new Set(['drafted>in_review', 'drafted>cancelled', 'in_review>drafted', 'in_review>approved', 'in_review>cancelled', 'approved>drafted', 'approved>cancelled']);
    for (const from of REPLY_STATUSES) {
      for (const to of REPLY_STATUSES) {
        expect(replyCanTransition(from, to), `${from} -> ${to}`).toBe(legal.has(`${from}>${to}`));
      }
    }
  });

  it('requires "approve" to move from in_review to approved', () => {
    expect(replyRequirementFor('in_review', 'approved')).toEqual(['approve']);
  });

  it('requires either create or edit to submit a draft for review', () => {
    expect(replyRequirementFor('drafted', 'in_review')).toEqual(['create', 'edit']);
  });

  it('cancelled is a dead end - nothing can move out of it', () => {
    for (const to of REPLY_STATUSES) expect(replyCanTransition('cancelled', to)).toBe(false);
  });

  it('a reply can still be edited while approved (which sends it back to drafted)', () => {
    expect(REPLY_EDITABLE).toContain('approved');
  });
});

describe('replyContentHash', () => {
  it('changes when the interaction or the text changes', () => {
    const base = replyContentHash('i1', 'Thanks!');
    expect(replyContentHash('i1', 'Thanks!')).toBe(base);
    expect(replyContentHash('i2', 'Thanks!')).not.toBe(base);
    expect(replyContentHash('i1', 'Thanks a lot!')).not.toBe(base);
  });

  it('looks like a SHA-256 hex digest', () => {
    expect(replyContentHash('i1', 'hi')).toMatch(/^[0-9a-f]{64}$/);
  });
});
