/**
 * VMS Autopilot permission vocabulary.
 *
 * These lists are mirrored by Postgres enums in
 * supabase/migrations/20260928000100_foundation_schema.sql - a test
 * (tests/db/schema.test.ts) fails if the two ever drift apart.
 */

export const ROLES = ['admin', 'team_member', 'client'] as const;
export type Role = (typeof ROLES)[number];

/** The nine permission levels from the PRD (section 3). */
export const ACTIONS = [
  'view',
  'create',
  'edit',
  'approve',
  'publish_execute',
  'delete',
  'billing',
  'manage_integration',
  'grant_permission',
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Product areas a permission can apply to. The first ten are the client-facing
 * modules from the PRD access matrix; the last six are agency control-centre areas.
 */
export const MODULES = [
  'seo_geo',
  'paid_ads',
  'domains',
  'website',
  'ai_assistant',
  'social',
  'leads_crm',
  'reports',
  'billing',
  'change_requests',
  'integrations',
  'approvals',
  'audit_log',
  'health_monitor',
  'settings',
  'clients',
] as const;
export type Module = (typeof MODULES)[number];

export type PermissionKey = readonly [Module, Action];

/** A permission an Admin has explicitly granted to a user (or to all client users). */
export type Grant = { module: Module; action: Action };

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const AUDIT_RESULTS = ['success', 'denied', 'failed', 'pending_approval'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];
