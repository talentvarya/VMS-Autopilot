/**
 * Phase G.7 - "Submit for review" on a draft website project. RLS (website_projects_update)
 * plus the database's own trigger enforce who may actually move a project from draft to
 * in_review.
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
  if (body?.status !== 'in_review') return NextResponse.json({ error: 'only submitting for review is supported here' }, { status: 400 });

  const { data, error } = await supabase.from('website_projects').update({ status: 'in_review' }).eq('id', id).select('id, status').single();
  if (error) return dbErrorResponse(error);
  return NextResponse.json({ project: data });
}
