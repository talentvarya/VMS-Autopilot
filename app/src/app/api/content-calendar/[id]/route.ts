/**
 * Phase G.14 - approving a single Content Calendar slot. RLS (social_calendar_update) already
 * requires private.can_do(workspace_id, 'social', 'edit'), same rule every other calendar-item
 * write goes through.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (body?.approvalStatus !== 'approved') {
    return NextResponse.json({ error: 'only approving is supported here' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('social_content_calendar_items')
    .update({ approval_status: 'approved' })
    .eq('id', id)
    .select('id, approval_status')
    .single();

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ item: data });
}
