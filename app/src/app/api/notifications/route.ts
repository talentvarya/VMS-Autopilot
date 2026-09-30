/**
 * Phase G.14 - real notifications for the bell icon. RLS (notifications_select) already scopes
 * this to the caller's own recipient_user_id - no workspace filter needed here.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { data, error } = await supabase
    .from('notifications')
    .select('id, workspace_id, kind, title, body, related_id, read_at, created_at')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) return dbErrorResponse(error);
  const unread = (data ?? []).filter(n => !n.read_at).length;
  return NextResponse.json({ notifications: data, unread });
}
