import { SandboxProvider, type SandboxOptions } from './sandbox-provider';
import type { SocialProvider } from './provider';
import type { Provider } from './types';

/**
 * Which publishing provider may be used.
 *
 * Phase 3: ONLY the sandbox. Connecting Buffer or any social account is switched off - by this
 * constant, by the absence of any Buffer code, by a test that fails if network code appears in
 * this folder, and by the database, which refuses any connection whose provider is not
 * 'sandbox'. Turning it on is a reviewed change that needs the owner's explicit approval.
 */
export const LIVE_SOCIAL_ENABLED = false as const;

export class LiveSocialDisabledError extends Error {
  constructor() {
    super('Connecting real social accounts is switched off. Only the built-in sandbox can be used until real integrations are approved.');
    this.name = 'LiveSocialDisabledError';
  }
}

export function createProvider(kind: Provider, options?: SandboxOptions): SocialProvider {
  if (kind === 'sandbox') return new SandboxProvider(options);
  // Even if the constant above were edited, no live provider exists in this code base.
  if (!LIVE_SOCIAL_ENABLED) throw new LiveSocialDisabledError();
  throw new LiveSocialDisabledError();
}
