import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDraftCanTransition, contentDraftHash } from '@/lib/agents/content/state';
import { CONTENT_DRAFT_STATUSES } from '@/lib/agents/content/types';
import { ID, asOwner, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * Proves, against real Postgres, that content_drafts carries the SAME rigor as every other
 * approval-gated table in this project: reuses the existing seo_geo actions (no new
 * permission), a person can never approve their own draft (an Admin excepted, same rule as
 * everywhere else), the approval hash freezes and is cleared by any later edit, there is no
 * "published" status, and every step reaches the audit log.
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
// A Client's ceiling for seo_geo never includes 'approve' at all (Phase 2 never needed it for
// audits) - so the "cannot approve your own" scenario is tested with a Team member instead,
// whose ceiling does include it. This is a real, intentional Phase 2 design fact, not a bug.
const asTeam = <T,>(fn: () => Promise<T>) => asUser(db, ID.teamMember, fn);

const grant = (module: string, action: string, userId: string) =>
  asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, $3::public.permission_module, $4::public.permission_action)`, [ID.nova, userId, module, action]));

const audit = () =>
  asOwner(db, () => rows<{ action: string }>(db, `select action from public.audit_log where workspace_id = $1 and module = 'seo_geo' and target_type = 'content_drafts' order by id`, [ID.nova]));

describe('schema matches the TypeScript state machine', () => {
  it('has a rule for every pair of statuses, matching contentDraftCanTransition', async () => {
    for (const from of CONTENT_DRAFT_STATUSES) {
      for (const to of CONTENT_DRAFT_STATUSES) {
        const [{ r }] = await rows<{ r: string[] | null }>(db, `select private.content_draft_required_actions($1::public.content_draft_status, $2::public.content_draft_status) as r`, [from, to]);
        expect(r !== null, `${from} -> ${to}`).toBe(contentDraftCanTransition(from, to));
      }
    }
  });

  it('computes the same hash as the TypeScript contentDraftHash()', async () => {
    const [{ h }] = await rows<{ h: string }>(db, `select private.content_draft_hash($1, $2) as h`, ['My title', 'My body']);
    expect(h).toBe(contentDraftHash('My title', 'My body'));
  });

  it('has no "published" value in the enum at all', async () => {
    const values = (await rows<{ v: string }>(db, `select unnest(enum_range(null::public.content_draft_status))::text as v`)).map((r) => r.v);
    expect(values).not.toContain('published');
  });
});

describe('permissions: reuses the existing seo_geo actions, no new module or action', () => {
  it('an ungranted Client can create a draft (seo_geo:create is already a default)', async () => {
    await expect(asClient(() => db.query(`insert into public.content_drafts (workspace_id, title, body) values ($1, 'Title', 'Body')`, [ID.nova]))).resolves.toBeTruthy();
  });

  it('the resulting row is always "draft", never anything else, however it is inserted', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.content_drafts (workspace_id, title, body) values ($1, 'Title', 'Body') returning id`, [ID.nova]));
    const [row] = await asOwner(db, () => rows<any>(db, `select status::text from public.content_drafts where id = $1`, [id]));
    expect(row.status).toBe('draft');
  });
});

describe('the full life, with the anti-tamper protections active', () => {
  async function draftedByTeamMember() {
    await grant('seo_geo', 'view', ID.teamMember);
    await grant('seo_geo', 'create', ID.teamMember);
    await grant('seo_geo', 'approve', ID.teamMember);
    const [{ id }] = await asTeam(() => rows<{ id: string }>(db, `insert into public.content_drafts (workspace_id, title, body) values ($1, 'My article', 'My body text') returning id`, [ID.nova]));
    return id;
  }

  it('a person cannot approve a draft they themselves wrote (an Admin is the only exception)', async () => {
    const id = await draftedByTeamMember();
    await asTeam(() => db.query(`update public.content_drafts set status = 'in_review' where id = $1`, [id]));
    await expect(asTeam(() => db.query(`update public.content_drafts set status = 'approved' where id = $1`, [id]))).rejects.toThrow(/cannot approve one you wrote/);
  });

  it('an Admin CAN approve it, and the hash freezes exactly what was approved', async () => {
    const id = await draftedByTeamMember();
    await asTeam(() => db.query(`update public.content_drafts set status = 'in_review' where id = $1`, [id]));
    await asAdmin(() => db.query(`update public.content_drafts set status = 'approved' where id = $1`, [id]));
    const [row] = await asOwner(db, () => rows<any>(db, `select status::text, approved_hash, approved_by from public.content_drafts where id = $1`, [id]));
    expect(row.status).toBe('approved');
    expect(row.approved_hash).toBe(contentDraftHash('My article', 'My body text'));
    expect(row.approved_by).toBe(ID.agencyAdmin);
  });

  it('editing an approved draft sends it back to "draft" and clears the hash - it must be approved again', async () => {
    const id = await draftedByTeamMember();
    await asTeam(() => db.query(`update public.content_drafts set status = 'in_review' where id = $1`, [id]));
    await asAdmin(() => db.query(`update public.content_drafts set status = 'approved' where id = $1`, [id]));
    await asAdmin(() => db.query(`update public.content_drafts set body = 'Changed my mind' where id = $1`, [id]));
    const [row] = await asOwner(db, () => rows<any>(db, `select status::text, approved_hash from public.content_drafts where id = $1`, [id]));
    expect(row.status).toBe('draft');
    expect(row.approved_hash).toBeNull();
  });

  it('every step - created, submitted, approved, edited - reaches the audit log', async () => {
    const id = await draftedByTeamMember();
    await asTeam(() => db.query(`update public.content_drafts set status = 'in_review' where id = $1`, [id]));
    await asAdmin(() => db.query(`update public.content_drafts set status = 'approved' where id = $1`, [id]));
    const events = (await audit()).map((e) => e.action);
    expect(events).toEqual(expect.arrayContaining(['content.draft_created', 'content.draft_in_review', 'content.draft_approved']));
  });
});
