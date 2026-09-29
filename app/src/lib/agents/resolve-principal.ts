/**
 * Resolves the signed-in caller's real role for a (usually client) workspace, the same way the
 * database's own role_of_user() does: a direct membership, or reaching down from their agency.
 * Shared by every route that calls into an agent, so each one doesn't re-derive this.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveRole, type Role } from '@/lib/permissions';

export interface ResolvedWorkspace {
  role: Role;
  /** The workspace's own agency (itself, if it IS the agency). Definitions/config live here. */
  agencyWorkspaceId: string;
}

export async function resolveWorkspaceRole(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<ResolvedWorkspace | null> {
  const { data: workspace } = await supabase.from('workspaces').select('id, kind, parent_workspace_id').eq('id', workspaceId).maybeSingle();
  if (!workspace) return null;
  const { data: memberships } = await supabase.from('workspace_members').select('workspace_id, role').eq('user_id', userId);
  const role = resolveRole(
    (memberships ?? []).map(m => ({ workspaceId: m.workspace_id, role: m.role })),
    { id: workspace.id, kind: workspace.kind, parentId: workspace.parent_workspace_id },
  );
  if (!role) return null;
  return { role, agencyWorkspaceId: workspace.kind === 'client' && workspace.parent_workspace_id ? workspace.parent_workspace_id : workspace.id };
}
