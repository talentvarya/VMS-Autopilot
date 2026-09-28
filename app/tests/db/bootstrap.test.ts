import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ID, asOwner, asUser, createDb, rows, useRollbackPerTest, type Db } from './harness';

const script = readFileSync(resolve(__dirname, '..', '..', 'supabase', 'manual', 'bootstrap_first_admin.sql'), 'utf8');
const withEmail = (email: string) => script.replace('REPLACE-WITH-YOUR-EMAIL@example.com', email);

let db: Db;
beforeAll(async () => {
  db = await createDb();
});
afterAll(async () => {
  await db.close();
});
useRollbackPerTest(() => db);

describe('first-admin bootstrap script', () => {
  it('refuses to run untouched, or for an email that has not signed up', async () => {
    await expect(asOwner(db, () => db.exec(script))).rejects.toThrow(/No login found/);
    await expect(asOwner(db, () => db.exec(withEmail('nobody@example.test')))).rejects.toThrow(/No login found/);
  });

  it('makes a signed-up person the Admin of a new agency, and only once', async () => {
    await db.query(`insert into auth.users (id, email) values ($1, 'boss@example.test')`, [ID.agencyAdmin]);
    await db.query(`insert into auth.users (id, email) values ($1, 'stranger@example.test')`, [ID.outsider]);
    await db.exec(withEmail('Boss@Example.test')); // email match ignores capitals

    await asUser(db, ID.agencyAdmin, async () => {
      const ws = await rows<{ name: string; kind: string }>(db, `select name, kind::text from public.workspaces`);
      expect(ws).toEqual([{ name: 'My Agency', kind: 'agency' }]);
    });
    // the stranger got nothing
    await asUser(db, ID.outsider, async () => {
      expect(await rows(db, `select 1 from public.workspaces`)).toEqual([]);
    });
    await expect(asOwner(db, () => db.exec(withEmail('boss@example.test')))).rejects.toThrow(/already an Admin/);
  });

  it('gives the new Admin working powers: they can now create a client workspace', async () => {
    await db.query(`insert into auth.users (id, email) values ($1, 'boss@example.test')`, [ID.agencyAdmin]);
    await db.exec(withEmail('boss@example.test'));
    const created = await asUser(db, ID.agencyAdmin, async () => {
      const [{ id }] = await rows<{ id: string }>(db, `select id from public.workspaces where kind = 'agency'`);
      return rows(db,
        `insert into public.workspaces (kind, parent_workspace_id, name) values ('client', $1, 'First Client') returning name`, [id]);
    });
    expect(created).toEqual([{ name: 'First Client' }]);
  });
});
