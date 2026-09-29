/**
 * Phase G.8 - real image generation for the sandbox Composer, same shape as
 * /api/social/generate-caption: real Anthropic/OpenAI call, real per-client cost tracking,
 * real daily/monthly caps enforced by the database's own trigger. Only the image itself is
 * real - posting stays fully sandboxed (no real channel, no live publish).
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createImageProvider } from '@/lib/agents/social/image';
import { AiUsageCapExceededError, checkAiUsageCap, recordAiCapBlockedEvent, recordAiUsage } from '@/lib/ai/usage-cap';
import { createSupabaseAgentStore, ensureAiUsageCapDefaults } from '@/lib/agents/supabase-store';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';
import { decide } from '@/lib/permissions';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!workspaceId) return NextResponse.json({ error: 'a client is required' }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: 'a prompt is required' }, { status: 400 });

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });

  // The Admin's own on/off switch (Social Publishing page) - OFF by default. This is checked
  // independently of, and in addition to, the code-level LIVE_IMAGE_GEN_ENABLED gate: even
  // with a real key configured, nothing calls it or costs anything until this is explicitly
  // turned on for this agency.
  const { data: agencySettings } = await supabase.from('workspace_settings').select('image_generation_enabled').eq('workspace_id', resolved.agencyWorkspaceId).maybeSingle();
  const toggledOn = agencySettings?.image_generation_enabled === true;
  if (!toggledOn) {
    return NextResponse.json({ error: 'Image generation is switched off. Turn on the toggle on the Social Publishing page to generate a real (billed) flyer.' }, { status: 403 });
  }

  const principal = { id: user.id, role: resolved.role, grants: [] };
  const mayAttemptReal = toggledOn && decide(principal, 'social', 'create').effect === 'allow';
  const provider = mayAttemptReal ? createImageProvider() : createImageProvider({ liveEnabled: false });
  const store = createSupabaseAgentStore(supabase);

  if (provider.kind === 'openai') {
    try {
      await ensureAiUsageCapDefaults(workspaceId);
      await checkAiUsageCap(store, workspaceId);
    } catch (err) {
      if (err instanceof AiUsageCapExceededError) {
        await recordAiCapBlockedEvent(store, principal, workspaceId, err.message);
        return NextResponse.json({ error: err.message }, { status: 429 });
      }
      throw err;
    }
  }

  const result = await provider.generateImage({ prompt });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 502 });

  if (provider.kind === 'openai') {
    await recordAiUsage(store, {
      workspaceId,
      provider: 'openai',
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
    });
  }

  return NextResponse.json({ imageRef: result.imageRef, altText: result.altText, sandbox: provider.kind === 'sandbox' });
}
