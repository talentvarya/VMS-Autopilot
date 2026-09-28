/**
 * Audit log helpers. The database records changes to permissions, memberships,
 * approvals, integrations and workspaces automatically (triggers). The application layer
 * uses these helpers to record everything else - especially denied attempts, which the
 * database never sees.
 *
 * Rule: every sensitive action records actor, workspace, timestamp (set by the database),
 * action, result and approval status - and never a secret.
 */

import type { AuditResult, ApprovalStatus, Module, Role } from './types';
import type { Decision } from './policy';

export interface AuditEvent {
  actorId: string | null;
  actorRole: Role | 'system' | null;
  workspaceId: string | null;
  module: Module | null;
  action: string;
  result: AuditResult;
  approvalId?: string | null;
  approvalStatus?: ApprovalStatus | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Keys whose value is hidden, whatever it contains. Mirrored in private.scrub_secrets(). */
export const SECRET_KEY_PATTERN =
  '(token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|bearer|credential|private[_-]?key|client[_-]?secret|refresh|cookie|session|jwt|dsn|signature)';
/** Values that look like a secret even under an innocent key. Mirrored in SQL. */
export const SECRET_VALUE_PATTERN =
  '^(sk[-_][A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\\.|Bearer\\s+\\S+|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})';

const SECRET_KEY = new RegExp(SECRET_KEY_PATTERN, 'i');
const SECRET_VALUE = new RegExp(SECRET_VALUE_PATTERN);
export const REDACTED = '[redacted]';

/**
 * Replace secrets with "[redacted]", at any depth: any value under a secret-looking key,
 * and any string that itself looks like a key/token. Mirrors private.scrub_secrets() in
 * SQL. Defence in depth: secrets should never be passed in, but if one slips through it
 * must not land in a log that Admins export.
 */
export function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? REDACTED : scrubSecrets(v),
      ]),
    );
  }
  if (typeof value === 'string' && SECRET_VALUE.test(value)) return REDACTED;
  return value;
}

/** Turn a permission decision into the audit event that must be written for it. */
export function auditEventForDecision(input: {
  actorId: string | null;
  actorRole: Role | null;
  workspaceId: string;
  module: Module;
  action: string;
  decision: Decision;
  approvalId?: string | null;
  metadata?: Record<string, unknown>;
}): AuditEvent {
  const { decision } = input;
  const result: AuditResult =
    decision.effect === 'deny' ? 'denied' : decision.effect === 'needs_approval' ? 'pending_approval' : 'success';
  return {
    actorId: input.actorId,
    actorRole: input.actorRole,
    workspaceId: input.workspaceId,
    module: input.module,
    action: input.action,
    result,
    approvalId: input.approvalId ?? null,
    approvalStatus: decision.effect === 'needs_approval' ? 'pending' : null,
    metadata: scrubSecrets(input.metadata ?? {}) as Record<string, unknown>,
  };
}
