/**
 * Real-Postgres test harness. Runs the actual migration files (in supabase/migrations)
 * inside PGlite - an in-process WebAssembly Postgres - so Row Level Security, triggers
 * and privileges are exercised for real. It never touches any network or Supabase project.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach } from 'vitest';

const appRoot = resolve(__dirname, '..', '..');
const migrationsDir = resolve(appRoot, 'supabase', 'migrations');

export const ID = {
  // people
  agencyAdmin: '00000000-0000-4000-8000-0000000000a1',
  agencyAdmin2: '00000000-0000-4000-8000-0000000000a2',
  teamMember: '00000000-0000-4000-8000-0000000000b1',
  clientNova: '00000000-0000-4000-8000-0000000000c1',
  clientNova2: '00000000-0000-4000-8000-0000000000c2',
  clientBright: '00000000-0000-4000-8000-0000000000c3',
  otherAgencyAdmin: '00000000-0000-4000-8000-0000000000d1',
  outsider: '00000000-0000-4000-8000-0000000000e1',
  // workspaces
  acme: '10000000-0000-4000-8000-000000000001',
  nova: '10000000-0000-4000-8000-000000000002',
  bright: '10000000-0000-4000-8000-000000000003',
  otherAgency: '10000000-0000-4000-8000-000000000004',
  otherClient: '10000000-0000-4000-8000-000000000005',
} as const;

export type Db = PGlite;

export async function createDb(): Promise<Db> {
  const db = new PGlite();
  await db.exec(readFileSync(resolve(__dirname, 'supabase-stub.sql'), 'utf8'));
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(resolve(migrationsDir, file), 'utf8'));
  }
  return db;
}

let savepointCounter = 0;

/**
 * Run a function as a logged-in user (Row Level Security applies). Pass null for
 * "not logged in" (anon). Must be called inside a transaction (see useRollbackPerTest):
 * a savepoint lets an expected database error be caught without poisoning the test.
 */
export async function asUser<T>(db: Db, userId: string | null, fn: () => Promise<T>): Promise<T> {
  const sp = `sp_${++savepointCounter}`;
  await db.exec(`savepoint ${sp}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  await db.exec(userId ? 'set role authenticated' : 'set role anon');
  try {
    const result = await fn();
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    await db.exec(`release savepoint ${sp}`);
    return result;
  } catch (error) {
    await db.exec(`rollback to savepoint ${sp}`);
    await db.exec('reset role');
    throw error;
  }
}

/** Run as the server-side service role (bypasses RLS, like the server would). */
export async function asService<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const sp = `sp_${++savepointCounter}`;
  await db.exec(`savepoint ${sp}`);
  await db.exec('set role service_role');
  try {
    const result = await fn();
    await db.exec('reset role');
    await db.exec(`release savepoint ${sp}`);
    return result;
  } catch (error) {
    await db.exec(`rollback to savepoint ${sp}`);
    await db.exec('reset role');
    throw error;
  }
}

/** Run as the database owner (like a manual bootstrap or migration). Errors are contained. */
export async function asOwner<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const sp = `sp_${++savepointCounter}`;
  await db.exec(`savepoint ${sp}`);
  try {
    const result = await fn();
    await db.exec(`release savepoint ${sp}`);
    return result;
  } catch (error) {
    await db.exec(`rollback to savepoint ${sp}`);
    throw error;
  }
}

/** Run a query and return just the rows. */
export async function rows<T = Record<string, any>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/** Wrap every test in a transaction that is rolled back, so tests never affect each other. */
export function useRollbackPerTest(getDb: () => Db) {
  beforeEach(async () => {
    await getDb().exec('begin');
  });
  afterEach(async () => {
    await getDb().exec('rollback');
  });
}

/**
 * Standard fixture (created as the database owner, i.e. like a manual bootstrap):
 *
 *   Acme Marketing (agency)               Other Agency (agency)
 *     admins: agencyAdmin, agencyAdmin2     admin: otherAgencyAdmin
 *     team:   teamMember                    Other Client (client)
 *     Nova Clinic (client): clientNova, clientNova2
 *     Bright Homes (client): clientBright
 *   outsider: has a login but belongs to nothing
 */
export async function seedFixture(db: Db) {
  const users = [
    ID.agencyAdmin, ID.agencyAdmin2, ID.teamMember, ID.clientNova, ID.clientNova2,
    ID.clientBright, ID.otherAgencyAdmin, ID.outsider,
  ];
  for (const [i, id] of users.entries()) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `user${i}@example.test`]);
  }
  await db.exec(`
    insert into public.workspaces (id, kind, parent_workspace_id, name) values
      ('${ID.acme}', 'agency', null, 'Acme Marketing'),
      ('${ID.otherAgency}', 'agency', null, 'Other Agency');
    insert into public.workspaces (id, kind, parent_workspace_id, name) values
      ('${ID.nova}', 'client', '${ID.acme}', 'Nova Clinic'),
      ('${ID.bright}', 'client', '${ID.acme}', 'Bright Homes'),
      ('${ID.otherClient}', 'client', '${ID.otherAgency}', 'Other Client');
    insert into public.workspace_members (workspace_id, user_id, role) values
      ('${ID.acme}', '${ID.agencyAdmin}', 'admin'),
      ('${ID.acme}', '${ID.agencyAdmin2}', 'admin'),
      ('${ID.acme}', '${ID.teamMember}', 'team_member'),
      ('${ID.nova}', '${ID.clientNova}', 'client'),
      ('${ID.nova}', '${ID.clientNova2}', 'client'),
      ('${ID.bright}', '${ID.clientBright}', 'client'),
      ('${ID.otherAgency}', '${ID.otherAgencyAdmin}', 'admin');
  `);
}
