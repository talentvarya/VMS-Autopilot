import { NETWORK_LABELS, LIMITS, type Network } from './types';
import { NETWORK_LIMITS, effectiveLength } from './networks';

/**
 * Checks a post before it goes for approval or gets scheduled. Messages are written for
 * clients: plain words, no jargon, and cautious - a warning says "check", not "this is wrong".
 *
 * `error` = cannot go ahead until fixed. `warning` = worth a look; can still go ahead.
 */

export interface Issue {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export interface PostDraft {
  network: Network;
  body: string;
  imageAlt?: string | null;
  scheduledAt?: string | null;
}

const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const LINK = /https?:\/\/\S+/gi;
/** Text people sometimes forget to replace. */
const PLACEHOLDER = /\b(lorem ipsum|insert (name|link|date|offer)|todo|tbd|xxx+)\b|\[(name|link|date|insert)[^\]]{0,40}\]/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function validatePost(post: PostDraft, now: Date = new Date()): Issue[] {
  const issues: Issue[] = [];
  const label = NETWORK_LABELS[post.network];
  const limits = NETWORK_LIMITS[post.network];
  const body = post.body ?? '';
  // On X, a link always counts as 23 characters no matter how long it really is; every other
  // network counts what is actually typed. Using the wrong count would wrongly block a post
  // that the network itself would accept (or the reverse).
  const length = effectiveLength(post.network, body);

  if (body.trim().length === 0) {
    issues.push({ level: 'error', code: 'body.empty', message: 'Write something first: the post is empty.' });
  }
  if (CONTROL.test(body)) {
    issues.push({ level: 'error', code: 'body.control_chars', message: 'The text contains hidden characters that some networks reject. Try pasting it as plain text.' });
  }
  if (length > limits.maxChars) {
    issues.push({ level: 'error', code: 'body.too_long', message: `${label} allows up to ${limits.maxChars.toLocaleString('en-US')} characters. This post counts as ${length.toLocaleString('en-US')}, so it is ${(length - limits.maxChars).toLocaleString('en-US')} too long.` });
  } else if (length > limits.maxChars * 0.9 && length > 0) {
    issues.push({ level: 'warning', code: 'body.near_limit', message: `This is close to the ${label} limit (${length} of ${limits.maxChars} characters). Please check it displays as you expect.` });
  }

  const hashtags = body.match(HASHTAG) ?? [];
  if (limits.hashtagsHard !== null && hashtags.length > limits.hashtagsHard) {
    issues.push({ level: 'error', code: 'hashtags.too_many', message: `${label} allows at most ${limits.hashtagsHard} hashtags. This post has ${hashtags.length}.` });
  } else if (limits.hashtagsAdvice === 0 && hashtags.length > 0) {
    issues.push({ level: 'warning', code: 'hashtags.many', message: `Hashtags are not clickable on ${label} and are not commonly used there. Consider removing them.` });
  } else if (hashtags.length > limits.hashtagsAdvice) {
    issues.push({ level: 'warning', code: 'hashtags.many', message: `You may want fewer hashtags. About ${limits.hashtagsAdvice} or fewer usually reads better on ${label} (this post has ${hashtags.length}).` });
  }

  const links = body.match(LINK) ?? [];
  if (links.length > 3) {
    issues.push({ level: 'warning', code: 'links.many', message: `This post has ${links.length} links. Please check they are all needed.` });
  }
  if (PLACEHOLDER.test(body)) {
    issues.push({ level: 'warning', code: 'body.placeholder', message: 'The text may still contain placeholder wording (like “[name]” or “TODO”). Please check before approving.' });
  }
  const letters = body.replace(LINK, '').replace(/[^\p{L}]/gu, ''); // web addresses are lower-case; ignore them
  if (letters.length >= 25 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    issues.push({ level: 'warning', code: 'body.all_caps', message: 'The whole post is in capital letters, which can look like shouting. Please check the tone.' });
  }

  if ((post.imageAlt ?? '').length > LIMITS.maxImageAltChars) {
    issues.push({ level: 'error', code: 'alt.too_long', message: `The picture description is too long (limit ${LIMITS.maxImageAltChars} characters).` });
  }
  if (limits.needsMedia) {
    issues.push({ level: 'warning', code: 'media.needed', message: `${label} will not accept this post without a picture or video. This early version supports text only, so add one before going live.` });
  }

  if (post.scheduledAt) {
    const when = new Date(post.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      issues.push({ level: 'error', code: 'schedule.invalid', message: 'That date and time is not valid.' });
    } else {
      const minutes = (when.getTime() - now.getTime()) / 60000;
      if (minutes < LIMITS.minLeadMinutes) {
        issues.push({ level: 'error', code: 'schedule.too_soon', message: `Choose a time at least ${LIMITS.minLeadMinutes} minutes from now, so there is time to check it.` });
      } else if (minutes > LIMITS.maxDaysAhead * 24 * 60) {
        issues.push({ level: 'error', code: 'schedule.too_far', message: `You can schedule up to ${LIMITS.maxDaysAhead} days ahead.` });
      }
    }
  }
  return issues;
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.level === 'error');
