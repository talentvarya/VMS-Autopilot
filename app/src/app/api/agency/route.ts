/**
 * Phase G.17 - the caller's own real agency name, for the header (which used to show a
 * hardcoded, fake 3-item "switch workspace" menu - "Acme Marketing", "VMS Demo Agency",
 * "Client Sandbox" - none of which exist in the database). A person belongs to exactly one
 * agency in this app's data model (workspace_members rows on the agency, client access
 * cascades from there - see private.role_of_user()), so there is nothing real to "switch"
 * between; this just returns the one real name.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { data, error } = await supabase
    .from('workspace_members')
    .select('workspaces!inner(id, name, kind)')
    .eq('user_id', user.id)
    .eq('workspaces.kind', 'agency')
    .limit(1)
    .maybeSingle();
  if (error) return dbErrorResponse(error);

  const agency = data?.workspaces as unknown as { id: string; name: string } | undefined;
  if (!agency) return NextResponse.json({ error: 'no agency workspace found for this account yet' }, { status: 400 });

  return NextResponse.json({ id: agency.id, name: agency.name });
}
