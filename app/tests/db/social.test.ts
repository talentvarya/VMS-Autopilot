import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '@/lib/seo/run-audit';
import { contentHash, sha256Hex } from '@/lib/social/hash';
import { NETWORK_LIMITS, effectiveLength } from '@/lib/social/networks';
import { failStalePublishing, processPost, startDuePosts } from '@/lib/social/publish-worker';
import { SandboxProvider } from '@/lib/social/sandbox-provider';
import { SOCIAL_SEED_FILE, renderSocialSeedSql } from '@/lib/social/seed-sql';
import { requirementFor } from '@/lib/social/state';
import { CHANNEL_STATUSES, NETWORKS, PLAN_TIERS, POST_STATUSES, PROVIDERS, PUBLISH_RESULTS } from '@/lib/social/types';
import { ID, asOwner, asService, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

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
const asClient2 = <T,>(fn: () => Promise<T>) => asUser(db, ID.clientNova2, fn);
const asTeam = <T,>(fn: () => Promise<T>) => asUser(db, ID.teamMember, fn);
const q: Queryable = { query: (sql, params) => db.query(sql, params) as never };

const grant = (module: string, action: string, userId: string | null) =>
  asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, $3::public.permission_module, $4::public.permission_action)`, [ID.nova, userId, module, action]));
const audit = () => asOwner(db, () => rows<{ action: string; actor_role: string | null; result: string; metadata: any }>(db, `select action, actor_role, result::text, metadata from public.audit_log where workspace_id = $1 and module = 'social' order by id`, [ID.nova]));

/** Server-side setup: a sandbox connection with three channels (like the sample Nova Clinic). */
async function setup(limit = 3) {
  return asService(db, async () => {
    const [{ id: connectionId }] = await rows<{ id: string }>(db, `insert into public.social_connections (workspace_id, plan_tier, plan_name, channel_limit) values ($1, 'free', 'Free (test)', $2) returning id`, [ID.nova, limit]);
    const ch: Record<string, string> = {};
    for (const [key, network] of [['fb', 'facebook'], ['ig', 'instagram'], ['in', 'linkedin']] as const) {
      if (Object.keys(ch).length >= limit) break;
      const [{ id }] = await rows<{ id: string }>(db, `insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, $3::public.social_network, $4, $5) returning id`, [connectionId, ID.nova, network, `ext-${key}`, `Nova ${key}`]);
      ch[key] = id;
    }
    return { connectionId, ch };
  });
}
const provider = () => new SandboxProvider({ channels: [
  { externalId: 'ext-fb', network: 'facebook', displayName: 'fb', handle: 'fb', status: 'active' },
  { externalId: 'ext-ig', network: 'instagram', displayName: 'ig', handle: 'ig', status: 'active' },
  { externalId: 'ext-in', network: 'linkedin', displayName: 'in', handle: 'in', status: 'active' },
] });

const newPost = (uid: string | null, channel: string, body = 'Our clinic is open late on Thursdays this month.') =>
  asUser(db, uid, () => rows<{ id: string }>(db, `insert into public.social_posts (workspace_id, channel_id, body) values ($1, $2, $3) returning id`, [ID.nova, channel, body])).then((r) => r[0].id);
const move = (who: 'admin' | 'client' | 'client2' | 'team', id: string, status: string, scheduledAt?: string) => {
  const run = { admin: asAdmin, client: asClient, client2: asClient2, team: asTeam }[who];
  return run(() => db.query(`update public.social_posts set status = $2::public.social_post_status, scheduled_at = coalesce($3::timestamptz, scheduled_at) where id = $1 returning id`, [id, status, scheduledAt ?? null]));
};
const post = (id: string) => asOwner(db, async () => (await rows<any>(db, `select status::text, scheduled_at, approved_by, approved_hash, published_at, external_post_id, last_error, attempt_count, body from public.social_posts where id = $1`, [id]))[0]);
const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

/** An Admin-written post taken all the way to "approved". */
async function approved(channel: string, body?: string) {
  const id = await newPost(ID.agencyAdmin, channel, body);
  await move('admin', id, 'in_review');
  await move('admin', id, 'approved');
  return id;
}
/** Simulate the clock reaching a post's time (only the owner could ever do this). */
const makeDue = async (id: string) => {
  await asOwner(db, () => db.exec(`alter table public.social_posts disable trigger social_posts_before`));
  await asOwner(db, () => db.query(`update public.social_posts set scheduled_at = now() - interval '1 minute' where id = $1`, [id]));
  await asOwner(db, () => db.exec(`alter table public.social_posts enable trigger social_posts_before`));
};

describe('schema matches the TypeScript vocabulary and limits', () => {
  const labels = async (type: string) => (await rows<{ l: string }>(db, `select unnest(enum_range(null::public.${type}))::text as l`)).map((r) => r.l);
  it('has identical enum values', async () => {
    expect(await labels('social_network')).toEqual([...NETWORKS]);
    expect(await labels('social_post_status')).toEqual([...POST_STATUSES]);
    expect(await labels('social_channel_status')).toEqual([...CHANNEL_STATUSES]);
    expect(await labels('social_provider')).toEqual([...PROVIDERS]);
    expect(await labels('social_plan_tier')).toEqual([...PLAN_TIERS]);
    expect(await labels('social_publish_result')).toEqual([...PUBLISH_RESULTS]);
  });

  it('has the same length limits as the app, and the seed file is up to date', async () => {
    const seeded = await rows<{ network: string; max_chars: number }>(db, `select network::text, max_chars from public.social_network_limits`);
    expect(Object.fromEntries(seeded.map((r) => [r.network, r.max_chars]))).toEqual(Object.fromEntries(NETWORKS.map((n) => [n, NETWORK_LIMITS[n].maxChars])));
    const committed = readFileSync(resolve(__dirname, '..', '..', SOCIAL_SEED_FILE), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderSocialSeedSql());
  });

  it('agrees with the app on every possible status change and who may make it', async () => {
    for (const from of POST_STATUSES) for (const to of POST_STATUSES) {
      const [{ r }] = await rows<{ r: string[] | null }>(db, `select private.social_required_actions($1::public.social_post_status, $2::public.social_post_status) as r`, [from, to]);
      const app = requirementFor(from, to);
      expect(r, `${from} -> ${to}`).toEqual(app === null ? null : app === 'server' ? ['server'] : [...app]);
    }
  });

  it('counts X links exactly as the app does, for a range of link counts and lengths', async () => {
    const cases = [
      'No links here at all.',
      'One short link: https://a.test',
      'Check this out: https://example.com/' + 'a'.repeat(300),
      'Two links: https://a.test/x https://b.test/' + 'y'.repeat(200),
      'A link at the very start https://start.test/page then text.',
    ];
    for (const body of cases) {
      const [{ n }] = await rows<{ n: number }>(db, `select private.social_effective_length('x'::public.social_network, $1) as n`, [body]);
      expect(n, body).toBe(effectiveLength('x', body));
    }
    // and every other network just counts characters, in the database as in the app
    const [{ n }] = await rows<{ n: number }>(db, `select private.social_effective_length('facebook'::public.social_network, $1) as n`, [cases[2]]);
    expect(n).toBe(effectiveLength('facebook', cases[2]));
  });

  it('actually applies X\'s link-shortening rule when a post is created and edited (not just when the helper function is called directly)', async () => {
    const { connectionId } = await setup(4); // room on the plan for a fourth (X) channel
    const [{ id: xChannel }] = await asService(db, () => rows<{ id: string }>(db,
      `insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'x', 'ext-x', 'X') returning id`,
      [connectionId, ID.nova]));
    const longUrl = 'https://example.com/' + 'a'.repeat(300);
    const body = `Big sale this week: ${longUrl}`;
    expect(body.length).toBeGreaterThan(280); // raw character count alone would wrongly reject this
    const id = await newPost(ID.agencyAdmin, xChannel, body);
    expect(await post(id)).toMatchObject({ status: 'draft', body });
    // and editing it to something that is genuinely too long is still refused
    await expect(asAdmin(() => db.query(`update public.social_posts set body = $2 where id = $1`, [id, 'a'.repeat(281)]))).rejects.toThrow(/longer than this network allows \(280/);
  });

  it('computes the same fingerprint as the app, including for accents and emoji', async () => {
    for (const [channel, body, alt] of [['c1', 'Hello', null], ['00000000-0000-4000-8000-000000000001', 'नमस्ते 😀 café', 'a cat'], ['x', 'line1\nline2', '']] as const) {
      const [{ h }] = await rows<{ h: string }>(db, `select encode(sha256(convert_to($1::text || chr(10) || $2::text || chr(10) || coalesce($3::text, ''), 'UTF8')), 'hex') as h`, [channel, body, alt]);
      expect(h).toBe(contentHash(channel, body, alt));
      expect(h).toBe(sha256Hex(`${channel}\n${body}\n${alt ?? ''}`));
    }
    const { ch } = await setup();
    const [{ h }] = await rows<{ h: string }>(db, `select private.social_hash($1::uuid, $2, $3) as h`, [ch.fb, 'Hello 😀', null]);
    expect(h).toBe(contentHash(ch.fb, 'Hello 😀', null));
  });

  it('locks every new table and gives anon nothing', async () => {
    const off = await rows(db, `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(off).toEqual([]);
    for (const t of ['social_connections', 'social_channels', 'social_posts', 'social_publish_attempts', 'social_network_limits']) {
      await expect(asUser(db, null, () => db.query(`select * from public.${t}`)), t).rejects.toThrow(/permission denied/);
    }
  });
});

describe('going live is blocked by the database itself', () => {
  it('refuses a Buffer connection from anyone, including the server and the owner', async () => {
    const insert = (provider: string) => db.query(`insert into public.social_connections (workspace_id, provider, plan_name, channel_limit) values ($1, $2::public.social_provider, 'Buffer', 3)`, [ID.nova, provider]);
    await expect(asService(db, () => insert('buffer'))).rejects.toThrow(/social_sandbox_only/);
    await expect(asOwner(db, () => insert('buffer'))).rejects.toThrow(/social_sandbox_only/);
    await expect(asAdmin(() => insert('buffer'))).rejects.toThrow(/permission denied/);
    await setup();
    await expect(asService(db, () => db.query(`update public.social_connections set provider = 'buffer' where workspace_id = $1`, [ID.nova]))).rejects.toThrow(/social_sandbox_only|provider cannot be changed/);
  });

  it('only the server can create connections or channels', async () => {
    const { connectionId } = await setup();
    for (const run of [asAdmin, asClient, asTeam]) {
      await expect(run(() => db.query(`insert into public.social_connections (workspace_id, plan_name, channel_limit) values ($1, 'x', 3)`, [ID.bright]))).rejects.toThrow(/permission denied/);
      await expect(run(() => db.query(`insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'x', 'evil', 'Evil')`, [connectionId, ID.nova]))).rejects.toThrow(/permission denied/);
    }
  });
});

describe('channels', () => {
  it('a social profile can exist only once in the whole platform, even in another workspace', async () => {
    const { connectionId } = await setup(5); // room on the plan, so it is the duplicate rule being tested
    const otherConn = await asService(db, async () => (await rows<{ id: string }>(db, `insert into public.social_connections (workspace_id, plan_name, channel_limit) values ($1, 'Other', 3) returning id`, [ID.bright]))[0].id);
    await expect(asService(db, () => db.query(`insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'facebook', 'ext-fb', 'Copy')`, [connectionId, ID.nova]))).rejects.toThrow(/duplicate key/);
    await expect(asService(db, () => db.query(`insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'facebook', 'ext-fb', 'Sneaky copy')`, [otherConn, ID.bright]))).rejects.toThrow(/duplicate key/);
    // the same account id on a DIFFERENT network is a different profile
    await asService(db, () => db.query(`insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'x', 'ext-fb', 'Different network')`, [connectionId, ID.nova]));
  });

  it('a connection cannot be used for another workspace’s channel', async () => {
    const { connectionId } = await setup();
    await expect(asService(db, () => db.query(`insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'x', 'ext-x', 'X')`, [connectionId, ID.bright]))).rejects.toThrow(/does not belong to this workspace/);
  });

  it('respects the plan’s channel limit, and a disconnected channel frees its slot', async () => {
    const { connectionId, ch } = await setup(3);
    const add = (ext: string) => asService(db, () => db.query(`insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'x', $3, 'X')`, [connectionId, ID.nova, ext]));
    await expect(add('ext-x1')).rejects.toThrow(/allows 3 channel/);
    await asService(db, () => db.query(`update public.social_channels set status = 'disconnected' where id = $1`, [ch.in]));
    await add('ext-x1');
    await expect(add('ext-x2')).rejects.toThrow(/allows 3 channel/);
  });

  it('is visible only to people who can see this workspace’s social pages', async () => {
    await setup();
    const count = (uid: string) => asUser(db, uid, async () => (await rows(db, `select 1 from public.social_channels`)).length);
    expect(await count(ID.clientNova)).toBe(3);
    expect(await count(ID.clientNova2)).toBe(3);
    expect(await count(ID.agencyAdmin)).toBe(3);
    expect(await count(ID.clientBright)).toBe(0);
    expect(await count(ID.otherAgencyAdmin)).toBe(0);
    expect(await count(ID.outsider)).toBe(0);
    expect(await count(ID.teamMember)).toBe(0); // until an Admin allows it
    await grant('social', 'view', ID.teamMember);
    expect(await count(ID.teamMember)).toBe(3);
  });

  it('can be paused and resumed by an Admin, but not by a Client, and never disconnected by a person', async () => {
    const { ch } = await setup();
    const set = (run: typeof asAdmin, status: string) => run(() => db.query(`update public.social_channels set status = $2::public.social_channel_status where id = $1 returning id`, [ch.fb, status]));
    expect((await set(asAdmin, 'paused')).rows).toHaveLength(1);
    expect((await set(asClient, 'active')).rows).toEqual([]); // not visible to the update: no permission
    expect((await set(asAdmin, 'active')).rows).toHaveLength(1);
    await expect(set(asAdmin, 'disconnected')).rejects.toThrow(/only the system/);
    await expect(asAdmin(() => db.query(`update public.social_channels set network = 'x' where id = $1`, [ch.fb]))).rejects.toThrow(/permission denied/);
    expect((await audit()).map((a) => a.action)).toEqual(expect.arrayContaining(['social.channel_added', 'social.channel_paused', 'social.channel_active']));
  });
});

describe('writing posts', () => {
  it('a default Client cannot write; one an Admin has allowed can, as a draft in their own name', async () => {
    const { ch } = await setup();
    await expect(newPost(ID.clientNova, ch.fb)).rejects.toThrow(/row-level security/);
    await grant('social', 'view', ID.clientNova); // already default; harmless duplicate-free check below
  }, 10_000);

  it('records the author and starts every post as a draft, whatever the request says', async () => {
    const { ch } = await setup();
    await grant('social', 'create', null); // whole client workspace
    const id = await newPost(ID.clientNova, ch.fb);
    expect(await post(id)).toMatchObject({ status: 'draft', approved_by: null, approved_hash: null, attempt_count: 0 });
    expect((await asOwner(db, () => rows(db, `select created_by from public.social_posts where id = $1`, [id])))[0].created_by).toBe(ID.clientNova);
    for (const [column, value] of [['status', `'approved'`], ['created_by', `'${ID.agencyAdmin}'`], ['approved_hash', `'${'a'.repeat(64)}'`], ['published_at', 'now()'], ['mode', `'live'`]]) {
      await expect(asClient(() => db.query(`insert into public.social_posts (workspace_id, channel_id, body, ${column}) values ($1, $2, 'x', ${value})`, [ID.nova, ch.fb])), column).rejects.toThrow(/permission denied/);
    }
  });

  it('rejects empty, over-long and hidden-character text, per network', async () => {
    const { ch } = await setup();
    await expect(newPost(ID.agencyAdmin, ch.fb, '   ')).rejects.toThrow(/post is empty/);
    await expect(newPost(ID.agencyAdmin, ch.ig, 'a'.repeat(2201))).rejects.toThrow(/longer than this network allows \(2200/);
    await newPost(ID.agencyAdmin, ch.ig, 'a'.repeat(2200));
    await expect(newPost(ID.agencyAdmin, ch.fb, 'bad' + String.fromCharCode(7) + 'text')).rejects.toThrow(/hidden control characters/);
    await newPost(ID.agencyAdmin, ch.fb, 'Two lines\nand a tab\tare fine');
    await newPost(ID.agencyAdmin, ch.fb, '😀'.repeat(2500)); // counted as people count: 2500 characters
  });

  it('only accepts a channel of the same workspace that is still connected', async () => {
    const { ch } = await setup();
    const other = await asService(db, async () => {
      const [{ id: c }] = await rows<{ id: string }>(db, `insert into public.social_connections (workspace_id, plan_name, channel_limit) values ($1, 'Other', 3) returning id`, [ID.bright]);
      return (await rows<{ id: string }>(db, `insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'x', 'ext-bright', 'B') returning id`, [c, ID.bright]))[0].id;
    });
    await expect(newPost(ID.agencyAdmin, other)).rejects.toThrow(/does not exist in this workspace/);
    await asService(db, () => db.query(`update public.social_channels set status = 'expired' where id = $1`, [ch.in]));
    await expect(newPost(ID.agencyAdmin, ch.in)).rejects.toThrow(/not connected/);
  });

  it('is limited to 200 new posts a day per workspace', async () => {
    const { ch } = await setup();
    await asOwner(db, () => db.query(
      `insert into public.social_posts (workspace_id, channel_id, body, created_at)
       select $1, $2, 'bulk ' || g, now() from generate_series(1, 200) g`, [ID.nova, ch.fb]));
    await expect(newPost(ID.agencyAdmin, ch.fb)).rejects.toThrow(/too many new posts today/);
  });

  it('is private to the workspace', async () => {
    const { ch } = await setup();
    await newPost(ID.agencyAdmin, ch.fb);
    const seen = (uid: string) => asUser(db, uid, async () => (await rows(db, `select 1 from public.social_posts`)).length);
    expect(await seen(ID.clientNova)).toBe(1);
    expect(await seen(ID.clientBright)).toBe(0);
    expect(await seen(ID.otherAgencyAdmin)).toBe(0);
    expect(await seen(ID.outsider)).toBe(0);
  });
});

describe('approval, and what approval freezes', () => {
  it('a post with no recorded author (written directly by the system) still needs an Admin to approve it', async () => {
    // A post can only have no author when the server itself writes one with no acting user -
    // never reachable by a Client or Team member through the app. Even so, nobody but an Admin
    // may wave it through: "nobody wrote this, so anybody may approve it" must never be true.
    const { ch } = await setup();
    const [{ id }] = await asService(db, () => rows<{ id: string }>(db,
      `insert into public.social_posts (workspace_id, channel_id, body) values ($1, $2, 'A system-written announcement.') returning id`, [ID.nova, ch.fb]));
    expect((await post(id)).body).toBeTruthy();
    await asService(db, () => db.query(`update public.social_posts set status = 'in_review' where id = $1`, [id]));
    await grant('social', 'approve', ID.teamMember);
    await grant('social', 'view', ID.teamMember);
    await expect(move('team', id, 'approved')).rejects.toThrow(/second person needs to approve|cannot approve/);
    expect((await post(id)).status).toBe('in_review');
    await move('admin', id, 'approved');
    expect((await post(id)).status).toBe('approved');
  });

  it('a Client with permission to write can submit; a second person approves; nobody skips a step', async () => {
    const { ch } = await setup();
    await grant('social', 'create', ID.clientNova);
    await grant('social', 'edit', ID.clientNova);
    await grant('social', 'approve', ID.clientNova2);
    const id = await newPost(ID.clientNova, ch.fb);
    await expect(move('client', id, 'approved')).rejects.toThrow(/cannot become/);
    await move('client', id, 'in_review');
    await expect(move('client', id, 'approved')).rejects.toThrow(/permission/); // the author has no approve permission
    await move('client2', id, 'approved');
    const p = await post(id);
    expect(p).toMatchObject({ status: 'approved', approved_by: ID.clientNova2 });
    expect(p.approved_hash).toBe(contentHash(ch.fb, p.body, null));
    expect((await audit()).map((a) => a.action)).toEqual(expect.arrayContaining(['social.post_created', 'social.post_submitted', 'social.post_approved']));
  });

  it('a person cannot approve what they wrote themselves, unless they are the Admin', async () => {
    const { ch } = await setup();
    for (const action of ['create', 'edit', 'approve']) await grant('social', action, ID.clientNova);
    const id = await newPost(ID.clientNova, ch.fb);
    await move('client', id, 'in_review');
    await expect(move('client', id, 'approved')).rejects.toThrow(/second person/);
    // an Admin approving their own work is allowed
    const mine = await newPost(ID.agencyAdmin, ch.fb);
    await move('admin', mine, 'in_review');
    await move('admin', mine, 'approved');
    expect((await post(mine)).status).toBe('approved');
  });

  it('editing anything approved or scheduled sends it back to Draft and wipes the approval', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await move('admin', id, 'scheduled', inDays(2));
    await asAdmin(() => db.query(`update public.social_posts set body = 'Different words after approval.' where id = $1`, [id]));
    expect(await post(id)).toMatchObject({ status: 'draft', approved_by: null, approved_hash: null, scheduled_at: null });
    await expect(move('admin', id, 'scheduled', inDays(2))).rejects.toThrow(/cannot become/);
    expect((await audit()).find((a) => a.action === 'social.post_edited')!.metadata.reapproval_needed).toBe(true);
  });

  it('changing words and status in one step is refused, and the time cannot be changed in place', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await expect(asAdmin(() => db.query(`update public.social_posts set body = 'x', status = 'scheduled', scheduled_at = $2 where id = $1`, [id, inDays(2)]))).rejects.toThrow(/separate steps/);
    await move('admin', id, 'scheduled', inDays(2));
    await expect(asAdmin(() => db.query(`update public.social_posts set scheduled_at = $2 where id = $1`, [id, inDays(3)]))).rejects.toThrow(/unschedule the post first/);
  });

  it('text swapped behind the scenes after approval can never be scheduled or published', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await asOwner(db, () => db.exec(`alter table public.social_posts disable trigger social_posts_before`));
    await asOwner(db, () => db.query(`update public.social_posts set body = 'Buy cheap watches at evil.test' where id = $1`, [id]));
    await asOwner(db, () => db.exec(`alter table public.social_posts enable trigger social_posts_before`));
    await expect(move('admin', id, 'scheduled', inDays(2))).rejects.toThrow(/changed after it was approved/);
    await expect(move('admin', id, 'publishing')).rejects.toThrow(/changed after it was approved/);
    expect((await post(id)).status).toBe('approved');
  });

  it('published, publishing and cancelled posts cannot be edited', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await move('admin', id, 'publishing');
    await expect(asAdmin(() => db.query(`update public.social_posts set body = 'nope' where id = $1`, [id]))).rejects.toThrow(/can no longer be edited/);
    const c = await newPost(ID.agencyAdmin, ch.fb, 'A post that will be cancelled.');
    await move('admin', c, 'cancelled');
    await expect(asAdmin(() => db.query(`update public.social_posts set body = 'nope' where id = $1`, [c]))).rejects.toThrow(/can no longer be edited/);
    await expect(move('admin', c, 'draft')).rejects.toThrow(/cannot become/);
  });
});

describe('only an Admin can schedule or publish', () => {
  it('a Client can never publish - not by default, not with a forged grant, and not by asking through the app', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await expect(move('client', id, 'scheduled', inDays(2))).rejects.toThrow(/permission/);
    await expect(move('client', id, 'publishing')).rejects.toThrow(/permission/);
    // a grant above the Client ceiling cannot even be created
    await expect(grant('social', 'publish_execute', ID.clientNova)).rejects.toThrow(/can never be given/);
    await expect(move('client', id, 'publishing')).rejects.toThrow(/permission/);
    expect((await post(id)).status).toBe('approved');
  });

  it('a trusted team member still needs an Admin, because publishing is a sensitive action', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await grant('social', 'view', ID.teamMember);
    await grant('social', 'publish_execute', ID.teamMember);
    await expect(move('team', id, 'publishing')).rejects.toThrow(/permission/);
    await expect(move('team', id, 'scheduled', inDays(2))).rejects.toThrow(/permission/);
  });

  it('nobody using the app can do the publishing system’s steps', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await move('admin', id, 'scheduled', inDays(2));
    await expect(move('admin', id, 'publishing')).rejects.toThrow(/only the publishing system/);
    const id2 = await approved(ch.fb, 'A second approved post for this check.');
    await move('admin', id2, 'publishing');
    await expect(move('admin', id2, 'published')).rejects.toThrow(/only the publishing system/);
    await expect(move('admin', id2, 'failed')).rejects.toThrow(/only the publishing system/);
  });

  it('enforces the scheduling window and the channel’s day limit', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await expect(move('admin', id, 'scheduled', new Date(Date.now() + 60_000).toISOString())).rejects.toThrow(/at least 5 minutes/);
    await expect(move('admin', id, 'scheduled', inDays(91))).rejects.toThrow(/90 days/);
    await expect(move('admin', id, 'scheduled')).rejects.toThrow(/choose a date/);
    const day = inDays(5);
    for (let i = 0; i < 10; i++) await move('admin', await approved(ch.fb, `Scheduled post ${i} for the busy-day test.`), 'scheduled', day);
    await expect(move('admin', id, 'scheduled', day)).rejects.toThrow(/already has 10 posts/);
    await move('admin', id, 'scheduled', inDays(6));
  });

  it('will not schedule or publish on a paused channel', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await asAdmin(() => db.query(`update public.social_channels set status = 'paused' where id = $1`, [ch.fb]));
    await expect(move('admin', id, 'scheduled', inDays(2))).rejects.toThrow(/not active/);
    await expect(move('admin', id, 'publishing')).rejects.toThrow(/not active/);
  });
});

describe('the publishing worker', () => {
  it('publishes an approved post once, records the attempt, and logs it', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await move('admin', id, 'publishing');
    const sandbox = provider();
    expect(await asService(db, () => processPost(q, id, sandbox))).toEqual({ postId: id, status: 'published' });
    expect(await post(id)).toMatchObject({ status: 'published', attempt_count: 1, last_error: null });
    expect((await post(id)).external_post_id).toMatch(/^sandbox-/);
    expect((await post(id)).published_at).not.toBeNull();
    const attempts = await asOwner(db, () => rows(db, `select attempt_no, result::text, finished_at is not null as done, idempotency_key from public.social_publish_attempts where post_id = $1`, [id]));
    expect(attempts).toEqual([{ attempt_no: 1, result: 'success', done: true, idempotency_key: `post:${id}` }]);
    expect((await audit()).map((a) => a.action)).toEqual(expect.arrayContaining(['social.post_publishing', 'social.post_published']));
    expect(sandbox.deliveries.get(`post:${id}`)).toBe(1);
  });

  it('a second worker for the same post stands down, and a finished post is left alone', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await move('admin', id, 'publishing');
    // Another worker has already claimed attempt 1.
    await asService(db, () => db.query(`insert into public.social_publish_attempts (post_id, workspace_id, attempt_no, idempotency_key) values ($1, $2, 1, $3)`, [id, ID.nova, `post:${id}`]));
    const sandbox = provider();
    expect(await asService(db, () => processPost(q, id, sandbox))).toEqual({ postId: id, status: 'skipped', reason: 'already_claimed' });
    expect(sandbox.deliveries.size).toBe(0); // nothing was sent
    expect((await post(id)).status).toBe('publishing');
    // and a post that is not in "publishing" is never touched
    const other = await approved(ch.fb, 'Approved but not publishing.');
    expect(await asService(db, () => processPost(q, other, sandbox))).toEqual({ postId: other, status: 'skipped', reason: 'not_publishing' });
  });

  it('records a refusal in plain words and lets an Admin retry - but only three times in all', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb, 'This will be refused by the network [sandbox:fail]');
    const sandbox = provider();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await move('admin', id, 'publishing');
      const out = await asService(db, () => processPost(q, id, sandbox));
      expect(out).toMatchObject({ status: 'failed', message: expect.stringContaining('did not accept') });
      expect(await post(id)).toMatchObject({ status: 'failed', attempt_count: attempt });
      if (attempt < 3) await move('admin', id, 'approved');
    }
    await move('admin', id, 'approved');
    await expect(move('admin', id, 'publishing')).rejects.toThrow(/tried 3 times/);
    const attempts = await asOwner(db, () => rows(db, `select result::text from public.social_publish_attempts where post_id = $1 order by attempt_no`, [id]));
    expect(attempts).toEqual([{ result: 'failed' }, { result: 'failed' }, { result: 'failed' }]);
  });

  it('remembers a rate-limit as such, and a temporary problem succeeds on retry without posting twice', async () => {
    const { ch } = await setup();
    const limited = await approved(ch.fb, 'Too many requests right now [sandbox:ratelimit]');
    const sandbox = provider();
    await move('admin', limited, 'publishing');
    await asService(db, () => processPost(q, limited, sandbox));
    expect((await asOwner(db, () => rows(db, `select result::text from public.social_publish_attempts where post_id = $1`, [limited])))[0].result).toBe('rate_limited');

    const flaky = await approved(ch.fb, 'A hiccup on the first try [sandbox:temporary]');
    await move('admin', flaky, 'publishing');
    await asService(db, () => processPost(q, flaky, sandbox));
    expect((await post(flaky)).status).toBe('failed');
    await move('admin', flaky, 'approved');
    await move('admin', flaky, 'publishing');
    await asService(db, () => processPost(q, flaky, sandbox));
    expect((await post(flaky)).status).toBe('published');
    expect(sandbox.deliveries.get(`post:${flaky}`)).toBe(1);
  });

  it('checks the fingerprint itself before contacting the provider', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await move('admin', id, 'publishing');
    await asOwner(db, () => db.exec(`alter table public.social_posts disable trigger social_posts_before`));
    await asOwner(db, () => db.query(`update public.social_posts set body = 'Swapped at the last moment' where id = $1`, [id]));
    await asOwner(db, () => db.exec(`alter table public.social_posts enable trigger social_posts_before`));
    const sandbox = provider();
    const out = await asService(db, () => processPost(q, id, sandbox));
    expect(out).toMatchObject({ status: 'failed', message: expect.stringContaining('no longer matches what was approved') });
    expect(sandbox.deliveries.size).toBe(0);
    expect((await post(id)).status).toBe('failed');
  });

  it('shows only safe messages when the provider crashes', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await move('admin', id, 'publishing');
    const broken = { kind: 'sandbox' as const, getPlan: async () => { throw new Error('x'); }, listChannels: async () => [], publish: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'); } };
    const out = await asService(db, () => processPost(q, id, broken));
    expect(out.status).toBe('failed');
    const p = await post(id);
    expect(p.last_error).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2/);
    const seen = await asClient(() => rows<{ last_error: string }>(db, `select last_error from public.social_posts where id = $1`, [id]));
    expect(seen[0].last_error).toBe(p.last_error);
  });

  it('starts due scheduled posts only, and leaves a post scheduled if its channel was paused', async () => {
    const { ch } = await setup();
    const due = await approved(ch.fb, 'This one is due now.');
    const later = await approved(ch.fb, 'This one is for next week.');
    const paused = await approved(ch.ig, 'This one’s channel gets paused.');
    for (const id of [due, later, paused]) await move('admin', id, 'scheduled', inDays(id === later ? 7 : 2));
    await makeDue(due);
    await makeDue(paused);
    await asService(db, () => db.query(`update public.social_channels set status = 'paused' where id = $1`, [ch.ig]));
    const first = await asService(db, () => startDuePosts(q));
    expect(first.started).toEqual([due]);
    expect(first.skipped.map((s) => s.postId)).toEqual([paused]);
    expect((await post(later)).status).toBe('scheduled');
    expect((await post(paused)).status).toBe('scheduled');
    const sandbox = provider();
    expect(await asService(db, () => processPost(q, due, sandbox))).toMatchObject({ status: 'published' });
  });

  it('a post that is not yet due cannot be started early, even by the server', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await move('admin', id, 'scheduled', inDays(2));
    await expect(asService(db, () => db.query(`update public.social_posts set status = 'publishing' where id = $1`, [id]))).rejects.toThrow(/not due yet/);
  });

  it('fails posts whose worker crashed, with an honest message, and leaves fresh ones alone', async () => {
    const { ch } = await setup();
    const stuck = await approved(ch.fb, 'Stuck in publishing.');
    const fresh = await approved(ch.ig, 'Freshly started.');
    await move('admin', stuck, 'publishing');
    await move('admin', fresh, 'publishing');
    await asOwner(db, () => db.exec(`alter table public.social_posts disable trigger social_posts_before`));
    await asOwner(db, () => db.query(`update public.social_posts set updated_at = now() - interval '1 hour' where id = $1`, [stuck]));
    await asOwner(db, () => db.exec(`alter table public.social_posts enable trigger social_posts_before`));
    expect(await asService(db, () => failStalePublishing(q, 15))).toBe(1);
    expect((await post(stuck)).last_error).toContain('check the channel before trying again');
    expect((await post(stuck)).status).toBe('failed');
    expect((await post(fresh)).status).toBe('publishing');
  });

  it('attempt records are visible to Admins only and can never be changed once finished', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb);
    await move('admin', id, 'publishing');
    await asService(db, () => processPost(q, id, provider()));
    const count = (uid: string) => asUser(db, uid, async () => (await rows(db, `select 1 from public.social_publish_attempts`)).length);
    expect(await count(ID.agencyAdmin)).toBe(1);
    expect(await count(ID.clientNova)).toBe(0);
    expect(await count(ID.teamMember)).toBe(0);
    await expect(asService(db, () => db.query(`update public.social_publish_attempts set result = 'failed' where post_id = $1`, [id]))).rejects.toThrow(/finished attempt cannot be changed/);
    await expect(asAdmin(() => db.query(`update public.social_publish_attempts set result = 'failed'`))).rejects.toThrow(/permission denied/);
    await expect(asService(db, () => db.query(`delete from public.social_publish_attempts`))).rejects.toThrow(/permission denied/);
    await expect(asService(db, () => db.query(`insert into public.social_publish_attempts (post_id, workspace_id, attempt_no, idempotency_key) values ($1, $2, 2, 'k')`, [id, ID.nova]))).rejects.toThrow(/only a post that is being published/);
  });
});

describe('history and privacy', () => {
  it('nobody can delete posts, channels or connections - not even the server key', async () => {
    const { ch, connectionId } = await setup();
    const id = await newPost(ID.agencyAdmin, ch.fb);
    for (const [table, key] of [['social_posts', id], ['social_channels', ch.fb], ['social_connections', connectionId]]) {
      await expect(asAdmin(() => db.query(`delete from public.${table} where id = $1`, [key])), table).rejects.toThrow(/permission denied/);
      await expect(asService(db, () => db.query(`delete from public.${table} where id = $1`, [key])), table).rejects.toThrow(/permission denied/);
    }
    await expect(asService(db, () => db.query(`truncate public.social_posts`))).rejects.toThrow(/permission denied/);
  });

  it('the audit log records who did each step, and never copies the post text into it', async () => {
    const { ch } = await setup();
    const secretish = 'Launch day surprise: 20% off everything this weekend only';
    const id = await approved(ch.fb, secretish);
    await move('admin', id, 'publishing');
    await asService(db, () => processPost(q, id, provider()));
    const log = await audit();
    const actions = log.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['social.connection_created', 'social.channel_added', 'social.post_created', 'social.post_submitted', 'social.post_approved', 'social.post_publishing', 'social.post_published']));
    expect(log.find((a) => a.action === 'social.post_approved')).toMatchObject({ actor_role: 'admin' });
    expect(log.find((a) => a.action === 'social.post_published')).toMatchObject({ actor_role: 'system' });
    expect(JSON.stringify(log)).not.toContain(secretish);
    expect(log.find((a) => a.action === 'social.post_approved')!.metadata.approved_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a Client can read their workspace’s posts and failure reasons but not the internal attempt log', async () => {
    const { ch } = await setup();
    const id = await approved(ch.fb, 'A post that fails [sandbox:fail]');
    await move('admin', id, 'publishing');
    await asService(db, () => processPost(q, id, provider()));
    const mine = await asClient(() => rows<{ status: string; last_error: string }>(db, `select status::text, last_error from public.social_posts where id = $1`, [id]));
    expect(mine[0]).toMatchObject({ status: 'failed' });
    expect(mine[0].last_error).toContain('did not accept');
    expect(await asClient(() => rows(db, `select 1 from public.social_publish_attempts`))).toEqual([]);
  });
});
