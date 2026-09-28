/**
 * Brand-voice and content-safety checking - a rule-based check against a workspace's own
 * brand_voice_profile, run BEFORE a draft is proposed. No AI call: this is a plain word-list
 * scan, deliberately simple and predictable rather than a judgement call.
 */

import type { BrandVoiceProfile } from './types';

export interface SafetyIssue {
  level: 'block' | 'warn';
  code: 'prohibited_word' | 'no_profile';
  message: string;
}

/**
 * A prohibited word is a BLOCK: the draft is never proposed. Anything else about brand voice
 * (tone, examples) is informational only in Sub-phase B and never blocks a draft - it is
 * recorded as a warning for the human reviewer.
 */
export function checkBrandVoice(profile: BrandVoiceProfile | null, text: string): SafetyIssue[] {
  if (!profile) return [];
  const lower = text.toLowerCase();
  const issues: SafetyIssue[] = [];
  for (const word of profile.prohibitedWords) {
    if (word.trim().length > 0 && lower.includes(word.trim().toLowerCase())) {
      issues.push({ level: 'block', code: 'prohibited_word', message: `contains a prohibited word: "${word}"` });
    }
  }
  return issues;
}

export const hasBlockingIssue = (issues: SafetyIssue[]) => issues.some((i) => i.level === 'block');
