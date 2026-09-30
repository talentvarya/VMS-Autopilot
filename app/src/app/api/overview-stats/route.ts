/**
 * Phase G.3 - real numbers for the Overview page's stat cards and activity feed. Replaces
 * the hardcoded "24 / 186 / 1,248 / 98%" and the three fixed Nova Clinic/Bright Homes/Urban
 * Eats timeline entries, all of which were static demo text, not live data.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [scheduledPosts, leadsThisMonth, healthChecks, recentActivity] = await Promise.all([
    supabase.from('social_posts').select('id', { count: 'exact', head: true }).eq('status', 'scheduled'),
    supabase.from('leads').select('id', { count: 'exact', head: true }).gte('created_at', startOfMonth.toISOString()),
    supabase.from('health_checks').select('status').order('checked_at', { ascending: false }).limit(50),
    supabase
      .from('audit_log')
      .select('id, at, action, target_type, workspaces(name)')
      .order('at', { ascending: false })
      .limit(5),
  ]);

  if (scheduledPosts.error) return dbErrorResponse(scheduledPosts.error);
  if (leadsThisMonth.error) return dbErrorResponse(leadsThisMonth.error);
  if (healthChecks.error) return dbErrorResponse(healthChecks.error);
  if (recentActivity.error) return dbErrorResponse(recentActivity.error);

  const checks = healthChecks.data ?? [];
  const healthScore = checks.length === 0 ? null : Math.round((checks.filter(c => c.status === 'pass').length / checks.length) * 100);

  return NextResponse.json({
    scheduledPosts: scheduledPosts.count ?? 0,
    leadsThisMonth: leadsThisMonth.count ?? 0,
    healthScore,
    recentActivity: recentActivity.data,
  });
}
