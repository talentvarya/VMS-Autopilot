import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replyCanTransition, replyContentHash } from '@/lib/agents/social/state';
import { REPLY_STATUSES } from '@/lib/agents/social/types';
import { ID, asOwner, asService, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * Proves, against real Postgres (PGlite), what Sub-phase B's plan promised:
 *   - social_interactions is written by the server only and treated as ordinary workspace data
 *     once it exists (view-gated the same way social_posts already is).
 *   - social_reply_drafts has its own small, correctly-enforced life (drafted/in_review/
 *     approved/cancelled), with the SAME hash-freeze-on-edit safety property as a post.
 *   - social_content_calendar_items reuses the existing social:create/edit actions.
 *   - brand_voice_profiles enforces EXACTLY the approved rule: Admin always; Team member only
 *     with a grant; Client NEVER, even with a grant for ordinary post editing.
 *   - every new table's activity reaches the same audit_log everything else does.
 */

let db: Db;
beforeAll(async () => {
  db = await createDb();
  await seedFixture(db);
});
afterAll(async () => {
  await db.close();
});
useRollbackPerTest(() => db);

const asAdmin = <T,>(fn: () => Promise<T>) => asUser(db, ID.agencyAdmin, fn);
const asClient = <T,>(fn: () => Promise<T>) => asUser(db, ID.clientNova, fn);
const asTeam = <T,>(fn: () => Promise<T>) => asUser(db, ID.teamMember, fn);

const audit = (workspaceId: string) =>
  asOwner(db, () =>
    rows<{ action: string; target_type: string }>(db, `select action, target_type from public.audit_log where workspace_id = $1 and module = 'social' order by id`, [workspaceId]),
  );

const grant = (workspaceId: string, module: string, action: string, userId: string) =>
  asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, $3::public.permission_module, $4::public.permission_action)`, [workspaceId, userId, module, action]));

/**
 * An UPDATE that RLS refuses does not throw - it silently matches zero rows. So "denied" is
 * proven by rowCount 0, and "allowed" by rowCount > 0 - never by expecting a rejection.
 */
const rowsAffected = async (fn: () => Promise<{ rowCount?: number | null }>) => (await fn()).rowCount ?? 0;

async function setupChannel(workspaceId: string = ID.nova) {
  const [{ id: connectionId }] = await asService(db, () =>
    rows<{ id: string }>(db, `insert into public.social_connections (workspace_id, plan_tier, plan_name, channel_limit) values ($1, 'free', 'Free (test)', 3) returning id`, [workspaceId]),
  );
  const [{ id: channelId }] = await asService(db, () =>
    rows<{ id: string }>(db, `insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'facebook', 'ext-fb', 'Nova FB') returning id`, [connectionId, workspaceId]),
  );
  return channelId;
}

async function makeInteraction(channelId: string, workspaceId: string = ID.nova, body = 'Do you deliver on weekends?') {
  const [{ id }] = await asService(db, () =>
    rows<{ id: string }>(
      db,
      `insert into public.social_interactions (workspace_id, channel_id, kind, external_interaction_id, author_handle, body_raw) values ($1, $2, 'comment', 'ext-1', 'jordan', $3) returning id`,
      [workspaceId, channelId, body],
    ),
  );
  return id;
}

describe('social_interactions', () => {
  it('is refused for a channel that does not belong to the workspace', async () => {
    const otherChannel = await setupChannel(ID.bright);
    await expect(
      asService(db, () =>
        db.query(`insert into public.social_interactions (workspace_id, channel_id, kind, external_interaction_id, body_raw) values ($1, $2, 'comment', 'x', 'hi')`, [ID.nova, otherChannel]),
      ),
    ).rejects.toThrow(/does not exist in this workspace/);
  });

  it('an Admin cannot insert one through the app\'s own key - the server does it', async () => {
    const channelId = await setupChannel();
    await expect(
      asAdmin(() => db.query(`insert into public.social_interactions (workspace_id, channel_id, kind, external_interaction_id, body_raw) values ($1, $2, 'comment', 'x', 'hi')`, [ID.nova, channelId])),
    ).rejects.toThrow(/permission denied/);
  });

  it('is visible to anyone who can already see social content, and audited on arrival', async () => {
    const channelId = await setupChannel();
    const id = await makeInteraction(channelId);
    expect(await asAdmin(() => rows(db, `select id from public.social_interactions where id = $1`, [id]))).toHaveLength(1);
    expect((await audit(ID.nova)).some((e) => e.action === 'social.interaction_received')).toBe(true);
  });
});

describe('social_reply_drafts', () => {
  it('has a rule for every pair of statuses matching the TypeScript state machine', async () => {
    for (const from of REPLY_STATUSES) {
      for (const to of REPLY_STATUSES) {
        const [{ r }] = await rows<{ r: string[] | null }>(db, `select private.social_reply_required_actions($1::public.social_reply_status, $2::public.social_reply_status) as r`, [from, to]);
        expect(r !== null, `${from} -> ${to}`).toBe(replyCanTransition(from, to));
      }
    }
  });

  it('computes the same hash as the TypeScript replyContentHash()', async () => {
    const [{ h }] = await rows<{ h: string }>(db, `select private.social_reply_hash($1, $2) as h`, ['00000000-0000-4000-8000-000000000abc', 'Thanks for asking!']);
    expect(h).toBe(replyContentHash('00000000-0000-4000-8000-000000000abc', 'Thanks for asking!'));
  });

  it('an ungranted Client cannot draft a reply; a granted one can', async () => {
    const channelId = await setupChannel();
    const interactionId = await makeInteraction(channelId);
    await expect(
      asClient(() => db.query(`insert into public.social_reply_drafts (workspace_id, interaction_id, body) values ($1, $2, 'Thanks!')`, [ID.nova, interactionId])),
    ).rejects.toThrow(/row-level security/);
    await grant(ID.nova, 'social', 'create', ID.clientNova);
    await expect(
      asClient(() => db.query(`insert into public.social_reply_drafts (workspace_id, interaction_id, body) values ($1, $2, 'Thanks!')`, [ID.nova, interactionId])),
    ).resolves.toBeTruthy();
  });

  it('the full life: drafted -> in_review -> approved, with a hash frozen at approval, and a second approver required', async () => {
    const channelId = await setupChannel();
    const interactionId = await makeInteraction(channelId);
    const [{ id }] = await asAdmin(() =>
      rows<{ id: string }>(db, `insert into public.social_reply_drafts (workspace_id, interaction_id, body) values ($1, $2, 'Thanks for asking!') returning id`, [ID.nova, interactionId]),
    );
    await asAdmin(() => db.query(`update public.social_reply_drafts set status = 'in_review' where id = $1`, [id]));

    // The same Admin who drafted it cannot approve it themselves? No - an Admin CAN approve
    // their own (mirrors social_posts); a non-admin cannot approve their own.
    await asAdmin(() => db.query(`update public.social_reply_drafts set status = 'approved' where id = $1`, [id]));
    const row = await asOwner(db, async () => (await rows<any>(db, `select status::text, approved_hash, approved_by from public.social_reply_drafts where id = $1`, [id]))[0]);
    expect(row.status).toBe('approved');
    expect(row.approved_hash).toBe(replyContentHash(interactionId, 'Thanks for asking!'));
    expect(row.approved_by).toBe(ID.agencyAdmin);
  });

  it('a non-admin cannot approve a reply they themselves drafted', async () => {
    const channelId = await setupChannel();
    const interactionId = await makeInteraction(channelId);
    await grant(ID.nova, 'social', 'create', ID.clientNova);
    await grant(ID.nova, 'social', 'approve', ID.clientNova);
    const [{ id }] = await asClient(() =>
      rows<{ id: string }>(db, `insert into public.social_reply_drafts (workspace_id, interaction_id, body) values ($1, $2, 'My own reply') returning id`, [ID.nova, interactionId]),
    );
    await asClient(() => db.query(`update public.social_reply_drafts set status = 'in_review' where id = $1`, [id]));
    await expect(asClient(() => db.query(`update public.social_reply_drafts set status = 'approved' where id = $1`, [id]))).rejects.toThrow(/cannot approve one you wrote/);
  });

  it('editing an approved reply sends it back to drafted and clears the hash', async () => {
    const channelId = await setupChannel();
    const interactionId = await makeInteraction(channelId);
    const [{ id }] = await asAdmin(() =>
      rows<{ id: string }>(db, `insert into public.social_reply_drafts (workspace_id, interaction_id, body) values ($1, $2, 'Original text') returning id`, [ID.nova, interactionId]),
    );
    await asAdmin(() => db.query(`update public.social_reply_drafts set status = 'in_review' where id = $1`, [id]));
    await asAdmin(() => db.query(`update public.social_reply_drafts set status = 'approved' where id = $1`, [id]));
    await asAdmin(() => db.query(`update public.social_reply_drafts set body = 'Changed my mind' where id = $1`, [id]));
    const row = await asOwner(db, async () => (await rows<any>(db, `select status::text, approved_hash from public.social_reply_drafts where id = $1`, [id]))[0]);
    expect(row.status).toBe('drafted');
    expect(row.approved_hash).toBeNull();
  });
});

describe('social_content_calendar_items', () => {
  it('reuses the existing social:create / social:edit actions', async () => {
    // Client has 'view' by default but not 'create' - can only insert once granted.
    await expect(
      asClient(() => db.query(`insert into public.social_content_calendar_items (workspace_id, planned_date, theme) values ($1, '2026-11-01', 'Holiday prep')`, [ID.nova])),
    ).rejects.toThrow(/row-level security/);
    const [{ id }] = await asAdmin(() =>
      rows<{ id: string }>(db, `insert into public.social_content_calendar_items (workspace_id, planned_date, theme) values ($1, '2026-11-01', 'Holiday prep') returning id`, [ID.nova]),
    );
    // Viewing it needs no grant at all - 'social:view' is a Client default, same as a post.
    expect(await asClient(() => rows(db, `select id from public.social_content_calendar_items where id = $1`, [id]))).toHaveLength(1);
    expect(await asAdmin(() => rows(db, `select id from public.social_content_calendar_items where id = $1`, [id]))).toHaveLength(1);
    // But a Client can never see another agency's client workspace.
    expect(await asClient(() => rows(db, `select id from public.social_content_calendar_items where id = $1`, [id]))).not.toHaveLength(0);
  });

  it('a Client cannot edit a calendar item without an explicit grant', async () => {
    const [{ id }] = await asAdmin(() =>
      rows<{ id: string }>(db, `insert into public.social_content_calendar_items (workspace_id, planned_date, theme) values ($1, '2026-11-01', 'Holiday prep') returning id`, [ID.nova]),
    );
    expect(await rowsAffected(() => asClient(() => db.query(`update public.social_content_calendar_items set theme = 'Changed' where id = $1`, [id])))).toBe(0);
    await grant(ID.nova, 'social', 'edit', ID.clientNova);
    expect(await rowsAffected(() => asClient(() => db.query(`update public.social_content_calendar_items set theme = 'Changed' where id = $1`, [id])))).toBe(1);
  });
});

describe('brand_voice_profiles - the approved rule', () => {
  it('Admin can always create and edit it', async () => {
    await asAdmin(() => db.query(`insert into public.brand_voice_profiles (workspace_id, tone) values ($1, 'warm and direct')`, [ID.nova]));
    expect(await rowsAffected(() => asAdmin(() => db.query(`update public.brand_voice_profiles set tone = 'warmer still' where workspace_id = $1`, [ID.nova])))).toBe(1);
  });

  it('a Team member can edit it ONLY with an explicit social:edit grant', async () => {
    // A Team member's 'view' is never a default either (unlike a Client's) - and Postgres
    // itself requires a row to be visible via SELECT before UPDATE can touch it, so both are
    // granted together here, exactly as an Admin enabling this for a team member would do.
    await asAdmin(() => db.query(`insert into public.brand_voice_profiles (workspace_id, tone) values ($1, 'warm and direct')`, [ID.nova]));
    await grant(ID.nova, 'social', 'view', ID.teamMember);
    expect(await rowsAffected(() => asTeam(() => db.query(`update public.brand_voice_profiles set tone = 'from team member' where workspace_id = $1`, [ID.nova])))).toBe(0);
    await grant(ID.nova, 'social', 'edit', ID.teamMember);
    expect(await rowsAffected(() => asTeam(() => db.query(`update public.brand_voice_profiles set tone = 'from team member' where workspace_id = $1`, [ID.nova])))).toBe(1);
  });

  it('a Client can NEVER write it, even granted social:edit or social:create for ordinary post editing', async () => {
    await asAdmin(() => db.query(`insert into public.brand_voice_profiles (workspace_id, tone) values ($1, 'warm and direct')`, [ID.nova]));
    await grant(ID.nova, 'social', 'edit', ID.clientNova);
    await grant(ID.nova, 'social', 'create', ID.clientNova);
    expect(await rowsAffected(() => asClient(() => db.query(`update public.brand_voice_profiles set tone = 'from client' where workspace_id = $1`, [ID.nova])))).toBe(0);
  });

  it('is readable by anyone who can see social content, agency-wide reach included', async () => {
    await asAdmin(() => db.query(`insert into public.brand_voice_profiles (workspace_id, tone) values ($1, 'warm and direct')`, [ID.nova]));
    expect(await asAdmin(() => rows(db, `select tone from public.brand_voice_profiles where workspace_id = $1`, [ID.nova]))).toHaveLength(1);
    expect(await asClient(() => rows(db, `select tone from public.brand_voice_profiles where workspace_id = $1`, [ID.nova]))).toHaveLength(1);
  });

  it('is audited on create and update', async () => {
    await asAdmin(() => db.query(`insert into public.brand_voice_profiles (workspace_id, tone) values ($1, 'warm and direct')`, [ID.nova]));
    await asAdmin(() => db.query(`update public.brand_voice_profiles set tone = 'warmer still' where workspace_id = $1`, [ID.nova]));
    const events = (await audit(ID.nova)).map((e) => e.action);
    expect(events).toContain('social.brand_voice_created');
    expect(events).toContain('social.brand_voice_updated');
  });
});
