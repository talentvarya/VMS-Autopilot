/**
 * Phase G.2 - real Leads & CRM list. RLS (leads_select) scopes results to workspaces the
 * caller holds 'leads_crm' view on.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { data, error } = await supabase
    .from('leads')
    .select('id, workspace_id, source, name, contact, status, created_at, workspaces(name)')
    .order('created_at', { ascending: false });

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ rows: data });
}

const LEAD_SOURCES = ['form', 'whatsapp', 'social_dm', 'manual'] as const;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id : '';
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : null;
  const contact = typeof body?.contact === 'string' && body.contact.trim() ? body.contact.trim() : null;
  const source = LEAD_SOURCES.includes(body?.source) ? body.source : 'manual';
  if (!workspaceId) return NextResponse.json({ error: 'a client is required' }, { status: 400 });
  if (!name && !contact) return NextResponse.json({ error: 'a name or contact is required' }, { status: 400 });

  const { data, error } = await supabase
    .from('leads')
    .insert({ workspace_id: workspaceId, source, name, contact })
    .select('id, workspace_id, source, name, contact, status, created_at, workspaces(name)')
    .single();

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ row: data }, { status: 201 });
}
