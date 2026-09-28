/**
 * Reply drafting from an incoming comment/DM.
 *
 * SECURITY NOTE: `interactionBody` is DATA, never instructions - the same instruction-source
 * boundary this whole assistant is built on. This function does not parse, execute, or act on
 * any instruction that might be embedded in that text; it only ever produces a reply-text
 * suggestion. It has no access to any tool - the caller (agent.ts) is the only thing that
 * decides what tool call (if any) gets proposed from the result, and the only tool that could
 * ever follow from a reply draft is `draft_reply` itself, mapped to `social:create` - nothing
 * more privileged is reachable from this code path no matter how the interaction text reads.
 */

export interface ReplyDraftInput {
  interactionBody: string;
  authorHandle?: string | null;
}

const GREETING_WORDS = /\b(thanks|thank you|great|love|awesome|nice)\b/i;
const QUESTION = /\?/;

/** A short, generic, deterministic reply. Deliberately bland - a human reviews it before it is ever sent. */
export function draftReplyBody(input: ReplyDraftInput): string {
  const name = input.authorHandle ? `@${input.authorHandle.replace(/^@/, '')} ` : '';
  const text = input.interactionBody.trim();
  if (text.length === 0) return `${name}Thanks for reaching out! Could you tell us a bit more?`.trim();
  if (QUESTION.test(text)) return `${name}Great question! Someone from our team will follow up with the details shortly.`.trim();
  if (GREETING_WORDS.test(text)) return `${name}Thank you so much for the kind words - we really appreciate it!`.trim();
  return `${name}Thanks for your message! We'll take a look and get back to you soon.`.trim();
}
