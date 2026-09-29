/**
 * Phase F.1 - staging environment configuration skeleton.
 *
 * Defines the environment TIERS this app can run in and how to detect which one is active.
 * Nothing here holds a secret, reads a real credential, or makes a network call - it only
 * answers "which tier am I" from environment variables that are already just labels
 * (APP_ENV, NODE_ENV), never values that need protecting.
 *
 * This is deliberately NOT wired into app startup yet - that belongs to a later Phase F step
 * once there is something real (an AI provider call, a Meta OAuth flow) that needs to be kept
 * out of production. Today it exists so later code has one place to ask "am I in staging?"
 * instead of re-deriving the answer in a dozen call sites.
 */

export const APP_ENVIRONMENTS = ['development', 'staging', 'production', 'test'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const DEFAULT_ENVIRONMENT: AppEnvironment = 'development';

/**
 * Reads APP_ENV first (the explicit, unambiguous signal this app defines for itself), falling
 * back to Node's own NODE_ENV for the two values it already sets meaningfully ('test' during
 * `vitest`, 'production' during `next build`/`next start`). An unrecognized or missing value
 * never throws - it falls back to 'development', the least-trusted tier - so a misconfigured
 * deploy fails safe (live features stay unreachable) rather than crashing outright.
 */
export function currentEnvironment(env: NodeJS.ProcessEnv = process.env): AppEnvironment {
  const raw = env.APP_ENV?.trim().toLowerCase();
  if (raw && (APP_ENVIRONMENTS as readonly string[]).includes(raw)) return raw as AppEnvironment;
  if (env.NODE_ENV === 'test') return 'test';
  if (env.NODE_ENV === 'production') return 'production';
  return DEFAULT_ENVIRONMENT;
}

export function isStaging(env?: NodeJS.ProcessEnv): boolean {
  return currentEnvironment(env) === 'staging';
}

export function isProduction(env?: NodeJS.ProcessEnv): boolean {
  return currentEnvironment(env) === 'production';
}

/**
 * Answers only "is a live path even conceivable in this tier" - it grants nothing by itself,
 * and every individual live feature still has its own separate, compile-time
 * LIVE_*_ENABLED switch (src/lib/social/sources.ts, src/lib/seo/sources.ts,
 * src/lib/agents/social/image.ts) that must ALSO be true. Development and test never qualify,
 * so a live code path can never be reached by accident while developing or running the suite.
 */
export function liveFeaturesConceivable(env?: NodeJS.ProcessEnv): boolean {
  const tier = currentEnvironment(env);
  return tier === 'staging' || tier === 'production';
}
