/**
 * Reels / short-video script generation - text only. No video is rendered, no AI call, no
 * network access. Produces a hook/body/CTA script plus a plain shot list.
 */

import type { Network } from '@/lib/social/types';

export interface VideoScriptInput {
  topic: string;
  network: Extract<Network, 'instagram' | 'tiktok' | 'youtube'>;
}

export interface VideoScript {
  hook: string;
  body: string;
  callToAction: string;
  shotList: string[];
}

export function draftVideoScript(input: VideoScriptInput): VideoScript {
  const topic = input.topic.trim();
  return {
    hook: `Stop scrolling - here's what you need to know about ${topic}.`,
    body: `Quick walkthrough of ${topic}: what it is, why it matters, and one thing to try today.`,
    callToAction: 'Follow for more, and drop your questions below.',
    shotList: [
      `Shot 1: talking head, hook line delivered to camera.`,
      `Shot 2: on-screen text summarising ${topic} in a few words.`,
      `Shot 3: quick demonstration or before/after related to ${topic}.`,
      `Shot 4: talking head, call to action.`,
    ],
  };
}
