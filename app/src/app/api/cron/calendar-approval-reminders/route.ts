/**
 * Phase G.14 - a Vercel Cron job (see vercel.json) that reminds an agency's Admins to approve a
 * real Content Calendar slot before it's due. For each calendar item still 'pending' whose
 * planned_date is exactly 2 days away, every Admin of that client's agency gets an in-app
 * notification. This job only ever reads calendar items and writes notifications; it never
 * approves anything and never touches a real post.
 *
 * Runs once daily (~12:00 IST, Vercel's own Hobby-plan limit - see the schedule's own comment
 * in vercel.json) rather than hourly between 12:00-15:00 as first asked for: a Hobby account's
 * cron jobs can only run once a day at all, so an hourly window needs a Pro plan instead - a
 * cost decision for the account owner, not made here. The 12:00-15:00/hourly window logic is
 * kept below (harmless on Hobby, since the single daily run always lands inside it) so it starts
 * working exactly as originally asked for the moment the project is ever upgraded to Pro and the
 * schedule in vercel.json is changed back to an every-30-minutes expression.
 */

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { istDateString, istHour } from '@/lib/notifications/ist-time';

const REMINDER_LEAD_DAYS = 2;
const REMINDER_WINDOW_START_HOUR = 12;
const REMINDER_WINDOW_END_HOUR = 15;
const DEDUPE_WINDOW_MS = 55 * 60 * 1000;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const hour = istHour();
  if (hour < REMINDER_WINDOW_START_HOUR || hour > REMINDER_WINDOW_END_HOUR) {
    return NextResponse.json({ skipped: true, reason: 'outside the 12:00-15:00 IST reminder window', istHour: hour });
  }

  const targetDate = istDateString(REMINDER_LEAD_DAYS);
  const service = createServiceClient();

  const { data: items, error: itemsError } = await service
    .from('social_content_calendar_items')
    .select('id, workspace_id, theme, planned_date')
    .eq('planned_date', targetDate)
    .eq('approval_status', 'pending');
  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });

  let notificationsCreated = 0;

  for (const item of items ?? []) {
    const { data: workspace } = await service
      .from('workspaces')
      .select('id, name, kind, parent_workspace_id')
      .eq('id', item.workspace_id)
      .maybeSingle();
    if (!workspace) continue;
    const agencyWorkspaceId = workspace.kind === 'agency' ? workspace.id : workspace.parent_workspace_id;
    if (!agencyWorkspaceId) continue;

    const { data: admins } = await service
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', agencyWorkspaceId)
      .eq('role', 'admin');

    for (const admin of admins ?? []) {
      const { data: recent } = await service
        .from('notifications')
        .select('id')
        .eq('recipient_user_id', admin.user_id)
        .eq('kind', 'calendar_approval_reminder')
        .eq('related_id', item.id)
        .gte('created_at', new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString())
        .limit(1);
      if (recent && recent.length > 0) continue;

      const { error: insertError } = await service.from('notifications').insert({
        recipient_user_id: admin.user_id,
        workspace_id: item.workspace_id,
        kind: 'calendar_approval_reminder',
        title: 'Content calendar needs approval',
        body: `"${item.theme}" is planned for ${item.planned_date} (${workspace.name}) and still needs your approval.`,
        related_id: item.id,
      });
      if (!insertError) notificationsCreated++;
    }
  }

  return NextResponse.json({ istHour: hour, targetDate, itemsChecked: items?.length ?? 0, notificationsCreated });
}
