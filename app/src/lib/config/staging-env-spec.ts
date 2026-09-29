/**
 * Phase F.1 - what a staging deployment is expected to have set, once later Phase F steps
 * (AI provider integration, Meta OAuth) are approved and built.
 *
 * No key is created, requested, or read for a real value anywhere in this file - it only
 * describes SHAPE (see env-validation.ts), so a staging deploy can be checked for
 * completeness before any live call is ever attempted. ANTHROPIC_API_KEY and the Meta OAuth
 * variables are listed as NOT required yet, because nothing in this codebase calls them until
 * a future sub-phase is approved and implemented - they exist here only so the shape is
 * already agreed on before that code is written.
 */

import type { EnvVarSpec } from './env-validation';

export const STAGING_ENV_SPEC: readonly EnvVarSpec[] = [
  {
    name: 'APP_ENV',
    required: true,
    shape: { kind: 'pattern', pattern: /^(development|staging|production|test)$/, description: 'one of development|staging|production|test' },
    purpose: 'which environment tier this deployment is',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    required: true,
    shape: { kind: 'url' },
    purpose: 'the staging Supabase project URL - never the production project',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    required: true,
    shape: { kind: 'nonEmpty' },
    purpose: 'browser-safe Supabase anon key, protected by Row Level Security',
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    required: true,
    shape: { kind: 'nonEmpty' },
    purpose: 'server-only Supabase key that bypasses Row Level Security - never exposed to the browser',
  },
  {
    name: 'ANTHROPIC_API_KEY',
    required: false,
    shape: { kind: 'pattern', pattern: /^sk-ant-/, description: 'starts with sk-ant-' },
    purpose: 'AI provider key - not required until the AI-provider integration sub-phase is approved and built',
  },
  {
    name: 'ANTHROPIC_MODEL',
    required: false,
    shape: { kind: 'nonEmpty' },
    purpose: 'overrides the default AI model (claude-sonnet-5-5) - optional, only read once ANTHROPIC_API_KEY is also configured',
  },
  {
    name: 'META_APP_ID',
    required: false,
    shape: { kind: 'nonEmpty' },
    purpose: 'Meta developer app identifier - not required until the Meta OAuth sub-phase is approved and built',
  },
  {
    name: 'META_APP_SECRET',
    required: false,
    shape: { kind: 'nonEmpty' },
    purpose: 'Meta developer app secret - not required until the Meta OAuth sub-phase is approved and built',
  },
] as const;
