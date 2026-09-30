/**
 * Phase G.14 - real Content Calendar list, RLS-scoped (social_calendar_select requires
 * private.holds(workspace_id, 'social', 'view')). Read-only here; approving a specific item is
 * PATCH /api/content-calendar/[id].
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const { data, error } = await supabase
    .from('social_content_calendar_items')
    .select('id, workspace_id, planned_date, theme, target_networks, approval_status, generated_by_agent, created_at')
    .eq('workspace_id', workspaceId)
    .order('planned_date', { ascending: true });

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ items: data });
}
