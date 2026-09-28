/**
 * VMS Autopilot permission policy - the single source of truth.
 *
 * The same rules exist in Postgres (private.action_decision in
 * supabase/migrations/20260928000200_security_functions_and_rls.sql). The tables that
 * drive the SQL side are GENERATED from this file (npm run gen:permissions), and
 * tests/db/parity.test.ts checks that TypeScript and SQL return the same answer for
 * every role x module x action combination.
 *
 * Model in one paragraph: a person's *role* in a workspace sets a hard CEILING (the most
 * they could ever be given). Inside that ceiling they get the role's DEFAULTS plus
 * anything an Admin has explicitly GRANTED. Anything SENSITIVE that a non-admin is allowed
 * to do is not executed directly - it becomes an approval request for an Admin. Only Admin
 * can grant, revoke or change permissions; nobody else can ever be given that power.
 */

import {
  ACTIONS,
  MODULES,
  ROLES,
  type Action,
  type Grant,
  type Module,
  type PermissionKey,
  type Role,
} from './types';

type ModuleActions = Partial<Record<Module, readonly Action[]>>;

/** Agency control-centre areas that only Admin can ever touch. */
export const ADMIN_ONLY_MODULES: readonly Module[] = [
  'settings',
  'clients',
  'audit_log',
  'health_monitor',
  'approvals',
];

/**
 * Most a Client can ever hold, per module. Derived from the PRD access matrix:
 * - website: preview only (change requests go through `change_requests`).
 * - ai_assistant: read-only, always. Client AI can never execute anything.
 * - seo_geo: can run audits; applying fixes needs a separate `publish_execute` grant;
 *   can never edit or delete audit data.
 * - integrations / approvals / audit_log / settings: never visible to clients.
 */
const CLIENT_CEILING: ModuleActions = {
  seo_geo: ['view', 'create', 'publish_execute'],
  paid_ads: ['view', 'create', 'edit', 'publish_execute', 'delete'],
  domains: ['view', 'create', 'edit', 'publish_execute', 'delete'],
  website: ['view'],
  ai_assistant: ['view'],
  social: ['view', 'create', 'edit', 'approve'],
  leads_crm: ['view', 'create', 'edit', 'delete'],
  reports: ['view'],
  billing: ['view', 'billing'],
  change_requests: ['view', 'create'],
};

/** What a Client gets with no Admin action at all (PRD "Client default" column). */
const CLIENT_DEFAULTS: ModuleActions = {
  seo_geo: ['view', 'create'], // view + run audit, download report
  website: ['view'], // preview
  ai_assistant: ['view'], // read-only answers
  social: ['view'],
  leads_crm: ['view'],
  reports: ['view'],
  change_requests: ['view', 'create'], // ask for a website change
};

/** Modules where a team member is capped below "everything". */
const TEAM_MEMBER_CAPS: ModuleActions = {
  ai_assistant: ['view'], // AI execution is Admin-only
  integrations: ['view', 'manage_integration'],
  billing: ['view', 'billing'],
};

function teamMemberCeiling(module: Module): readonly Action[] {
  if (ADMIN_ONLY_MODULES.includes(module)) return [];
  const capped = TEAM_MEMBER_CAPS[module];
  if (capped) return capped;
  // Everything except the three actions that only make sense on one specific module,
  // and grant_permission which is Admin-only.
  return ACTIONS.filter(
    (a) => a !== 'grant_permission' && a !== 'manage_integration' && a !== 'billing',
  );
}

/** Highest set of actions a role may ever hold on a module. */
export function ceilingActions(role: Role, module: Module): readonly Action[] {
  if (role === 'admin') return ACTIONS;
  if (role === 'client') return CLIENT_CEILING[module] ?? [];
  return teamMemberCeiling(module);
}

export function inCeiling(role: Role, module: Module, action: Action): boolean {
  return ceilingActions(role, module).includes(action);
}

/** Actions a role holds by default (before any Admin grant). Team members start with none. */
export function defaultActions(role: Role, module: Module): readonly Action[] {
  if (role === 'admin') return ACTIONS;
  if (role === 'client') return CLIENT_DEFAULTS[module] ?? [];
  return [];
}

/** Explicit sensitive combinations. Delete and grant_permission are sensitive everywhere. */
const SENSITIVE_EXPLICIT: ModuleActions = {
  paid_ads: ['edit', 'publish_execute'], // budget change / pause, launch
  domains: ['create', 'edit', 'publish_execute'], // buy/connect, DNS, transfer
  website: ['publish_execute'], // deploy / rollback
  social: ['publish_execute'], // publish
  seo_geo: ['publish_execute'], // apply a recommendation
  billing: ['billing'],
  integrations: ['manage_integration'],
  ai_assistant: ['publish_execute'], // AI executing a command
  clients: ['create'],
  approvals: ['approve'],
};

export function isSensitive(module: Module, action: Action): boolean {
  if (action === 'delete' || action === 'grant_permission') return true;
  return SENSITIVE_EXPLICIT[module]?.includes(action) ?? false;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type Effect = 'allow' | 'deny' | 'needs_approval';

export type DecisionReason =
  | 'admin'
  | 'default'
  | 'granted'
  | 'approval_required'
  | 'not_a_member'
  | 'above_role_ceiling'
  | 'not_granted';

export interface Decision {
  effect: Effect;
  reason: DecisionReason;
  /** The action is on the sensitive list: it must always be written to the audit log. */
  auditRequired: boolean;
  /** The UI must ask the person for explicit confirmation before sending it. */
  requiresConfirmation: boolean;
}

export interface Principal {
  /** Effective role in the target workspace, or null if they have no access to it. */
  role: Role | null;
  /** Active grants an Admin has given this person (or all client users) in that workspace. */
  grants: readonly Grant[];
}

export interface DecisionContext {
  /**
   * Extra "module:action" pairs an Admin has chosen to force through approval for this
   * workspace (workspace_settings.approval_policy). Applies to non-admin roles.
   */
  approvalPolicy?: readonly string[];
}

export function decide(
  principal: Principal,
  module: Module,
  action: Action,
  ctx: DecisionContext = {},
): Decision {
  const sensitive = isSensitive(module, action);
  const make = (effect: Effect, reason: DecisionReason): Decision => ({
    effect,
    reason,
    auditRequired: sensitive,
    requiresConfirmation: sensitive && effect !== 'deny',
  });

  const { role } = principal;
  if (role === null) return make('deny', 'not_a_member');
  if (role === 'admin') return make('allow', 'admin');
  if (!inCeiling(role, module, action)) return make('deny', 'above_role_ceiling');

  const isDefault = defaultActions(role, module).includes(action);
  const isGranted = principal.grants.some((g) => g.module === module && g.action === action);
  if (!isDefault && !isGranted) return make('deny', 'not_granted');

  const forcedByPolicy = ctx.approvalPolicy?.includes(`${module}:${action}`) ?? false;
  if (sensitive || forcedByPolicy) return make('needs_approval', 'approval_required');
  return make('allow', isDefault ? 'default' : 'granted');
}

// ---------------------------------------------------------------------------
// Workspace access (tenant isolation)
// ---------------------------------------------------------------------------

export interface WorkspaceRef {
  id: string;
  kind: 'agency' | 'client';
  parentId: string | null;
}

export interface Membership {
  workspaceId: string;
  role: Role;
}

/**
 * Effective role of a person in a workspace. A direct membership wins; otherwise an
 * agency Admin/Team member reaches the client workspaces underneath their agency.
 * A client user reaches only their own workspace - never a sibling, never the agency.
 */
export function resolveRole(memberships: readonly Membership[], workspace: WorkspaceRef): Role | null {
  const reachesViaAgency = (m: Membership) =>
    workspace.kind === 'client' && workspace.parentId !== null && m.workspaceId === workspace.parentId;
  const roles = memberships
    .filter((m) => m.workspaceId === workspace.id || reachesViaAgency(m))
    .map((m) => m.role);
  // If someone holds more than one role here, the most powerful one wins - so a lower
  // direct membership can never strip an agency Admin of their authority.
  return roles.sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b])[0] ?? null;
}

const ROLE_RANK: Record<Role, number> = { admin: 0, team_member: 1, client: 2 };

// ---------------------------------------------------------------------------
// Granting
// ---------------------------------------------------------------------------

/** Only Admin can grant, revoke or change permissions. Nobody else, ever. */
export function canManagePermissions(role: Role | null): boolean {
  return role === 'admin';
}

export type GrantCheck = { ok: true } | { ok: false; reason: 'admin_needs_no_grant' | 'above_role_ceiling' };

/** Would granting (module, action) to a person with this role be allowed? */
export function checkGrant(targetRole: Role, module: Module, action: Action): GrantCheck {
  if (targetRole === 'admin') return { ok: false, reason: 'admin_needs_no_grant' };
  if (!inCeiling(targetRole, module, action)) return { ok: false, reason: 'above_role_ceiling' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rows for the SQL lookup tables (used by the generator and the parity test)
// ---------------------------------------------------------------------------

function pairsFor(role: Role, pick: (r: Role, m: Module) => readonly Action[]) {
  return MODULES.flatMap((m) =>
    ACTIONS.filter((a) => pick(role, m).includes(a)).map((a) => [role, m, a] as const),
  );
}

const NON_ADMIN_ROLES = ROLES.filter((r) => r !== 'admin');

export const CEILING_ROWS = NON_ADMIN_ROLES.flatMap((r) => pairsFor(r, ceilingActions));
export const DEFAULT_ROWS = NON_ADMIN_ROLES.flatMap((r) => pairsFor(r, defaultActions));
export const SENSITIVE_ROWS: readonly PermissionKey[] = MODULES.flatMap((m) =>
  ACTIONS.filter((a) => isSensitive(m, a)).map((a) => [m, a] as const),
);
