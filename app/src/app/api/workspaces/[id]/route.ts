/**
 * Phase G.4 - the "..." menu on a client row. RLS (workspaces_update) only lets an Admin of
 * the workspace write to it. Phase G.16 adds website_url to the grantable columns (name,
 * industry, archived_at, website_url) - see the privilege grant next to workspaces_update.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';
import { UnsafeUrlError, assertSafeUrl } from '@/lib/seo/safe-url';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const update: Record<string, string | null> = {};
  if (typeof body?.name === 'string' && body.name.trim()) update.name = body.name.trim();
  if (body?.archive === true) update.archived_at = new Date().toISOString();
  if (body?.archive === false) update.archived_at = null;
  if (typeof body?.websiteUrl === 'string') {
    if (!body.websiteUrl.trim()) {
      update.website_url = null;
    } else {
      try {
        update.website_url = assertSafeUrl(body.websiteUrl.trim()).href;
      } catch (err) {
        return NextResponse.json({ error: err instanceof UnsafeUrlError ? `website address: ${err.reason}` : 'website address is invalid' }, { status: 400 });
      }
    }
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('workspaces')
    .update(update)
    .eq('id', id)
    .select('id, name, industry, kind, website_url, created_at')
    .single();

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ workspace: data });
}
