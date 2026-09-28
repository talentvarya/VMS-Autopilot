/**
 * Sandbox image/carousel generation (Sub-phase B). Mirrors src/lib/social/provider.ts +
 * sources.ts exactly: an interface, ONE sandbox implementation, and a compile-time switch
 * that keeps any real image-generation provider out of this codebase until it is separately
 * approved and built.
 */

export interface ImageRequest {
  prompt: string;
  brandGuidelines?: { tone?: string | null };
}

export type ImageResult = { ok: true; imageRef: string; altText: string } | { ok: false; message: string };

export interface ImageProvider {
  readonly kind: 'sandbox';
  generateImage(request: ImageRequest): Promise<ImageResult>;
  /** A carousel is just several images generated together, in order. */
  generateCarousel(requests: ImageRequest[]): Promise<ImageResult[]>;
}

/**
 * Real image generation is switched off - by this constant, by the absence of any real
 * provider code, and by a test that fails if network code appears in this file. Turning it on
 * is a reviewed change that needs the owner's explicit approval, exactly like
 * LIVE_SOCIAL_ENABLED in src/lib/social/sources.ts.
 */
export const LIVE_IMAGE_GEN_ENABLED = false as const;

export class LiveImageGenDisabledError extends Error {
  constructor() {
    super('Real image generation is switched off. Only the built-in sandbox can be used until a real provider is approved.');
    this.name = 'LiveImageGenDisabledError';
  }
}

/** A pretend image generator: no network call, no AI provider, deterministic given the same prompt. */
export class SandboxImageProvider implements ImageProvider {
  readonly kind = 'sandbox' as const;
  private n = 0;

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    if (request.prompt.trim().length === 0) return { ok: false, message: 'the image prompt is empty' };
    this.n += 1;
    return { ok: true, imageRef: `sandbox-image-${this.n}`, altText: request.prompt.slice(0, 200) };
  }

  async generateCarousel(requests: ImageRequest[]): Promise<ImageResult[]> {
    const results: ImageResult[] = [];
    for (const request of requests) results.push(await this.generateImage(request));
    return results;
  }
}

export function createImageProvider(): ImageProvider {
  if (!LIVE_IMAGE_GEN_ENABLED) return new SandboxImageProvider();
  throw new LiveImageGenDisabledError();
}
