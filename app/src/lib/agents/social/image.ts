/**
 * Image/carousel generation. Mirrors caption-ai-provider.ts's own shape exactly: an interface,
 * a SANDBOX implementation (deterministic, no network), and a REAL implementation only ever
 * reachable once a compile-time switch AND the environment tier both agree - never by a
 * runtime toggle.
 *
 * The real path calls OpenAI's Images API directly over fetch (no SDK - this project's only AI
 * SDK dependency is @anthropic-ai/sdk, used exclusively for text; one REST call does not
 * warrant a second whole SDK). The key is read from the exact environment variable name the
 * owner created it under (Image_Generation_30_days_chatGPT) - never logged, never returned,
 * never included in an error message. GPT image models always return base64 image data, never
 * a hosted URL, so every generated image is uploaded to the 'social-images' Supabase Storage
 * bucket (public read; see supabase/migrations/20260930000100_social_image_storage.sql) using
 * the service-role client, and the public URL of that upload is what this module returns.
 */

import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { liveFeaturesConceivable } from '@/lib/config/environment';

export interface ImageRequest {
  prompt: string;
  brandGuidelines?: { tone?: string | null };
}

export type ImageResult =
  | { ok: true; imageRef: string; altText: string; model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { ok: false; message: string };

export interface ImageProvider {
  readonly kind: 'sandbox' | 'openai';
  generateImage(request: ImageRequest): Promise<ImageResult>;
  /** A carousel is just several images generated together, in order. */
  generateCarousel(requests: ImageRequest[]): Promise<ImageResult[]>;
}

/**
 * Reviewed and approved 2026-09-30 - the owner explicitly chose real image generation (an
 * OpenAI key, added by them directly in Vercel) over staying sandbox-only or using a
 * template-based flyer service. Turning this back off is a reviewed code change, exactly like
 * LIVE_SOCIAL_CAPTION_AI_ENABLED in caption-ai-provider.ts.
 */
export const LIVE_IMAGE_GEN_ENABLED = true as const;

const MAX_PROMPT_CHARS = 4000;
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const DEFAULT_MODEL = 'gpt-image-2.5-flare';

export class OpenAiNotConfiguredError extends Error {
  constructor() {
    super('Image_Generation_30_days_chatGPT is not set. Real image generation cannot run until it is configured.');
    this.name = 'OpenAiNotConfiguredError';
  }
}

function getOpenAiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.Image_Generation_30_days_chatGPT?.trim();
  if (!key) throw new OpenAiNotConfiguredError();
  return key;
}

function getConfiguredImageModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENAI_IMAGE_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_MODEL;
}

/** $ per 1M tokens, by modality - see https://developers.openai.com/api/docs/pricing (image
 * generation models section, read 2026-09-30). Verify against OpenAI's current published
 * pricing before relying on this for real billing decisions - the same caveat usage-cap.ts
 * already states about its own Anthropic pricing table. */
const IMAGE_PRICING_USD_PER_MILLION_TOKENS: Record<string, { textInput: number; imageInput: number; imageOutput: number }> = {
  'gpt-image-2.5-flare': { textInput: 5, imageInput: 8, imageOutput: 30 },
  'gpt-image-2.5-sunburst': { textInput: 5, imageInput: 8, imageOutput: 30 },
};
const DEFAULT_IMAGE_PRICING = { textInput: 5, imageInput: 8, imageOutput: 30 };

interface OpenAiImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  output_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

function estimateImageCostUsd(model: string, usage: OpenAiImageUsage | undefined): number {
  if (!usage) return 0;
  const pricing = IMAGE_PRICING_USD_PER_MILLION_TOKENS[model] ?? DEFAULT_IMAGE_PRICING;
  const textIn = usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? 0;
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
  const imageOut = usage.output_tokens_details?.image_tokens ?? usage.output_tokens ?? 0;
  return (textIn * pricing.textInput + imageIn * pricing.imageInput + imageOut * pricing.imageOutput) / 1_000_000;
}

/** A pretend image generator: no network call, no AI provider, deterministic given the same prompt. */
export class SandboxImageProvider implements ImageProvider {
  readonly kind = 'sandbox' as const;
  private n = 0;

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    if (request.prompt.trim().length === 0) return { ok: false, message: 'the image prompt is empty' };
    this.n += 1;
    return { ok: true, imageRef: `sandbox-image-${this.n}`, altText: request.prompt.slice(0, 200), model: 'sandbox', inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }

  async generateCarousel(requests: ImageRequest[]): Promise<ImageResult[]> {
    const results: ImageResult[] = [];
    for (const request of requests) results.push(await this.generateImage(request));
    return results;
  }
}

/** Real image generation. Only ever constructed once both live gates have already passed. */
export class OpenAiImageProvider implements ImageProvider {
  readonly kind = 'openai' as const;

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    if (request.prompt.trim().length === 0) return { ok: false, message: 'the image prompt is empty' };
    if (request.prompt.length > MAX_PROMPT_CHARS) return { ok: false, message: `the image prompt is too long (max ${MAX_PROMPT_CHARS} characters)` };

    const apiKey = getOpenAiApiKey();
    const model = getConfiguredImageModel();

    let response: Response;
    try {
      response = await fetch(OPENAI_IMAGES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt: request.prompt, n: 1, size: '1024x1024', output_format: 'png' }),
      });
    } catch {
      return { ok: false, message: 'could not reach the image provider' };
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      return { ok: false, message: `image generation failed (${response.status}): ${errorBody.slice(0, 300) || response.statusText}` };
    }

    const body = await response.json();
    const b64 = body?.data?.[0]?.b64_json;
    if (!b64 || typeof b64 !== 'string') return { ok: false, message: 'the image provider returned no image data' };

    const buffer = Buffer.from(b64, 'base64');
    const path = `${randomUUID()}.png`;
    const supabase = createServiceClient();
    const { error: uploadError } = await supabase.storage.from('social-images').upload(path, buffer, { contentType: 'image/png', upsert: false });
    if (uploadError) return { ok: false, message: `could not save the generated image: ${uploadError.message}` };
    const { data: publicUrl } = supabase.storage.from('social-images').getPublicUrl(path);

    const usage = body?.usage as OpenAiImageUsage | undefined;
    return {
      ok: true,
      imageRef: publicUrl.publicUrl,
      altText: (body?.data?.[0]?.revised_prompt as string | undefined)?.slice(0, 200) ?? request.prompt.slice(0, 200),
      model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      estimatedCostUsd: estimateImageCostUsd(model, usage),
    };
  }

  async generateCarousel(requests: ImageRequest[]): Promise<ImageResult[]> {
    const results: ImageResult[] = [];
    for (const request of requests) results.push(await this.generateImage(request));
    return results;
  }
}

export class LiveImageGenDisabledError extends Error {
  constructor() {
    super('Real image generation is switched off. Only the built-in sandbox can be used until a real provider is approved.');
    this.name = 'LiveImageGenDisabledError';
  }
}

/**
 * `overrides` exists ONLY so a test can exercise a specific path explicitly without depending
 * on the real committed LIVE_IMAGE_GEN_ENABLED constant or the real process.env - application
 * code never passes it, so production and staging always follow the real, committed switch and
 * the real environment. Outside staging/production this ALWAYS returns the sandbox provider,
 * silently - never an error, even once LIVE_IMAGE_GEN_ENABLED is true.
 */
export function createImageProvider(overrides?: { liveEnabled?: boolean; env?: NodeJS.ProcessEnv }): ImageProvider {
  const liveEnabled = overrides?.liveEnabled ?? LIVE_IMAGE_GEN_ENABLED;
  if (!liveEnabled) return new SandboxImageProvider();
  if (!liveFeaturesConceivable(overrides?.env)) return new SandboxImageProvider();
  return new OpenAiImageProvider();
}
