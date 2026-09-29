/**
 * Phase G.8b - the agency-wide "image generation" on/off switch, and any future agency-level
 * toggle like it. Read/write scoped to the caller's own agency workspace via RLS
 * (settings_select / settings_update already require private.is_admin(workspace_id)).
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

async function findAgencyWorkspaceId(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces!inner(kind)')
    .eq('user_id', userId)
    .eq('workspaces.kind', 'agency')
    .limit(1);
  return data?.[0]?.workspace_id ?? null;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const agencyWorkspaceId = await findAgencyWorkspaceId(supabase, user.id);
  if (!agencyWorkspaceId) return NextResponse.json({ error: 'no agency workspace found for this account yet' }, { status: 400 });

  const { data, error } = await supabase.from('workspace_settings').select('image_generation_enabled').eq('workspace_id', agencyWorkspaceId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ imageGenerationEnabled: data?.image_generation_enabled ?? false });
}

export async function PATCH(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (typeof body?.imageGenerationEnabled !== 'boolean') return NextResponse.json({ error: 'imageGenerationEnabled (boolean) is required' }, { status: 400 });

  const agencyWorkspaceId = await findAgencyWorkspaceId(supabase, user.id);
  if (!agencyWorkspaceId) return NextResponse.json({ error: 'no agency workspace found for this account yet' }, { status: 400 });

  const { error } = await supabase.from('workspace_settings').update({ image_generation_enabled: body.imageGenerationEnabled }).eq('workspace_id', agencyWorkspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ imageGenerationEnabled: body.imageGenerationEnabled });
}
