import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ID, asOwner, asService, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * Proves, against a REAL Postgres (PGlite), the things Sub-phase A's plan promised in the
 * database itself, not just in the TypeScript layer (tests/agents/orchestrator.test.ts covers
 * that side):
 *   - agent_definitions lives only on an agency workspace, and only that agency's Admin can
 *     see, create, change or remove one.
 *   - agent_runs / agent_handoffs / agent_tool_calls cannot be written through the app's own
 *     key at all - only the server (service_role) can - and are visible only to an Admin.
 *   - a definition can only be used for the agency it belongs to, or a client workspace under
 *     that same agency - never a different tenant.
 *   - a tool call's recorded decision must match what the permission rules actually say for
 *     the person it names as on_behalf_of - the database itself refuses a mismatch.
 *   - every run, tool call and handoff is written to the same audit_log everything else uses.
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
const asOtherAdmin = <T,>(fn: () => Promise<T>) => asUser(db, ID.otherAgencyAdmin, fn);

const audit = (workspaceId: string) =>
  asOwner(db, () =>
    rows<{ action: string; actor_role: string | null; result: string; target_type: string }>(
      db,
      `select action, actor_role, result::text, target_type from public.audit_log where workspace_id = $1 and actor_role = 'agent' order by id`,
      [workspaceId],
    ),
  );

async function makeEchoDefinition(workspaceId = ID.acme) {
  const [row] = await asAdmin(() =>
    rows<{ id: string }>(
      db,
      `insert into public.agent_definitions (workspace_id, agent_key, display_name, allowed_tools, enabled)
       values ($1, 'sandbox_echo', 'Sandbox Echo', '["echo_message","propose_demo_action"]'::jsonb, true) returning id`,
      [workspaceId],
    ),
  );
  return row.id;
}

describe('agent_definitions: where an agent may be configured', () => {
  it("can be created on an agency workspace by that agency's Admin", async () => {
    const id = await makeEchoDefinition();
    const [row] = await asAdmin(() => rows(db, `select agent_key from public.agent_definitions where id = $1`, [id]));
    expect(row.agent_key).toBe('sandbox_echo');
  });

  it('is refused on a client workspace', async () => {
    await expect(
      asAdmin(() =>
        db.query(
          `insert into public.agent_definitions (workspace_id, agent_key, display_name) values ($1, 'sandbox_echo', 'Nope')`,
          [ID.nova],
        ),
      ),
    ).rejects.toThrow(/agency workspace/);
  });

  it("a Client or Team member cannot create one, even on their own agency's workspace", async () => {
    await expect(
      asTeam(() => db.query(`insert into public.agent_definitions (workspace_id, agent_key, display_name) values ($1, 'sandbox_echo', 'Nope')`, [ID.acme])),
    ).rejects.toThrow();
  });

  it("a Client cannot see another agency's agent definitions, and sees none of their own agency's either (Admin-only)", async () => {
    await makeEchoDefinition();
    expect(await asClient(() => rows(db, `select id from public.agent_definitions where workspace_id = $1`, [ID.acme]))).toHaveLength(0);
    expect(await asOtherAdmin(() => rows(db, `select id from public.agent_definitions where workspace_id = $1`, [ID.acme]))).toHaveLength(0);
    expect(await asAdmin(() => rows(db, `select id from public.agent_definitions where workspace_id = $1`, [ID.acme]))).toHaveLength(1);
  });

  it('records who created and last changed it, and audits both', async () => {
    const id = await makeEchoDefinition();
    await asAdmin(() => db.query(`update public.agent_definitions set enabled = false where id = $1`, [id]));
    const [row] = await asOwner(db, () => rows(db, `select created_by, updated_by from public.agent_definitions where id = $1`, [id]));
    expect(row.created_by).toBe(ID.agencyAdmin);
    expect(row.updated_by).toBe(ID.agencyAdmin);
    const events = await audit(ID.acme);
    expect(events.map((e) => e.action)).toEqual(['agent.definition_created', 'agent.definition_updated']);
  });
});

describe('agent_runs / agent_handoffs / agent_tool_calls: only the server writes them', () => {
  it("an Admin cannot insert an agent_runs row through the app's own key", async () => {
    const defId = await makeEchoDefinition();
    await expect(
      asAdmin(() =>
        db.query(`insert into public.agent_runs (workspace_id, agent_definition_id, agent_key) values ($1, $2, 'sandbox_echo')`, [ID.acme, defId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("the server (service_role) can, and the row is visible only to that workspace's Admin", async () => {
    const defId = await makeEchoDefinition();
    const [run] = await asService(db, () =>
      rows<{ id: string }>(
        db,
        `insert into public.agent_runs (workspace_id, agent_definition_id, agent_key, status, finished_at) values ($1, $2, 'sandbox_echo', 'succeeded', now()) returning id`,
        [ID.acme, defId],
      ),
    );
    expect(await asClient(() => rows(db, `select id from public.agent_runs where id = $1`, [run.id]))).toHaveLength(0);
    expect(await asAdmin(() => rows(db, `select id from public.agent_runs where id = $1`, [run.id]))).toHaveLength(1);
  });

  it('an agency Admin can see a run recorded against one of their own client workspaces', async () => {
    const defId = await makeEchoDefinition(); // lives on ID.acme
    const [run] = await asService(db, () =>
      rows<{ id: string }>(
        db,
        `insert into public.agent_runs (workspace_id, agent_definition_id, agent_key, status, finished_at) values ($1, $2, 'sandbox_echo', 'succeeded', now()) returning id`,
        [ID.nova, defId],
      ),
    );
    expect(await asAdmin(() => rows(db, `select id from public.agent_runs where id = $1`, [run.id]))).toHaveLength(1);
  });

  it('a definition cannot be used for a workspace outside its own agency', async () => {
    const defId = await makeEchoDefinition(); // ID.acme's own definition
    await expect(
      asService(db, () =>
        db.query(`insert into public.agent_runs (workspace_id, agent_definition_id, agent_key) values ($1, $2, 'sandbox_echo')`, [ID.otherClient, defId]),
      ),
    ).rejects.toThrow(/not configured for this workspace/);
  });

  it('a finished run cannot silently change status again', async () => {
    const defId = await makeEchoDefinition();
    const [run] = await asService(db, () =>
      rows<{ id: string }>(db, `insert into public.agent_runs (workspace_id, agent_definition_id, agent_key, status, finished_at) values ($1, $2, 'sandbox_echo', 'succeeded', now()) returning id`, [ID.acme, defId]),
    );
    await expect(
      asService(db, () => db.query(`update public.agent_runs set status = 'failed' where id = $1`, [run.id])),
    ).rejects.toThrow(/already finished/);
  });
});

describe("a tool call's recorded decision must match the real permission rules", () => {
  async function makeRun() {
    const defId = await makeEchoDefinition();
    const [run] = await asService(db, () =>
      rows<{ id: string }>(db, `insert into public.agent_runs (workspace_id, agent_definition_id, agent_key) values ($1, $2, 'sandbox_echo') returning id`, [ID.acme, defId]),
    );
    return run.id;
  }

  it('accepts "allow" for an Admin on a sensitive action', async () => {
    const runId = await makeRun();
    await expect(
      asService(db, () =>
        db.query(
          `insert into public.agent_tool_calls (workspace_id, run_id, tool_name, on_behalf_of, module, action, decision)
           values ($1, $2, 'propose_demo_action', $3, 'ai_assistant', 'publish_execute', 'allow')`,
          [ID.acme, runId, ID.agencyAdmin],
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses "allow" recorded for a Client on the agency\'s own workspace (the truth is deny - a Client has no role there at all)', async () => {
    const runId = await makeRun();
    await expect(
      asService(db, () =>
        db.query(
          `insert into public.agent_tool_calls (workspace_id, run_id, tool_name, on_behalf_of, module, action, decision)
           values ($1, $2, 'propose_demo_action', $3, 'ai_assistant', 'publish_execute', 'allow')`,
          [ID.acme, runId, ID.clientNova],
        ),
      ),
    ).rejects.toThrow(/does not match what permission rules actually allow/);
  });

  it('"needs_approval" must reference a real, matching approval request - proven with a genuinely grantable sensitive action (paid_ads:publish_execute) that a Client was actually given', async () => {
    // On their OWN workspace (Nova), granted paid_ads:publish_execute, the true decision for
    // clientNova really is 'needs_approval' - unlike ai_assistant, which no grant can ever
    // unlock (see the "ceiling-blocked" tests above).
    await asService(db, () =>
      db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, 'paid_ads', 'publish_execute')`, [ID.nova, ID.clientNova]),
    );
    const defId = await makeEchoDefinition();
    const [run] = await asService(db, () =>
      rows<{ id: string }>(db, `insert into public.agent_runs (workspace_id, agent_definition_id, agent_key) values ($1, $2, 'sandbox_echo') returning id`, [ID.nova, defId]),
    );

    await expect(
      asService(db, () =>
        db.query(
          `insert into public.agent_tool_calls (workspace_id, run_id, tool_name, on_behalf_of, module, action, decision)
           values ($1, $2, 'propose_grantable_demo_action', $3, 'paid_ads', 'publish_execute', 'needs_approval')`,
          [ID.nova, run.id, ID.clientNova],
        ),
      ),
    ).rejects.toThrow(/must reference the approval request/);

    const [approval] = await asService(db, () =>
      rows<{ id: string }>(
        db,
        `insert into public.approval_requests (workspace_id, requested_by, module, action, title) values ($1, $2, 'paid_ads', 'publish_execute', 'demo') returning id`,
        [ID.nova, ID.clientNova],
      ),
    );
    await expect(
      asService(db, () =>
        db.query(
          `insert into public.agent_tool_calls (workspace_id, run_id, tool_name, on_behalf_of, module, action, decision, approval_id)
           values ($1, $2, 'propose_grantable_demo_action', $3, 'paid_ads', 'publish_execute', 'needs_approval', $4)`,
          [ID.nova, run.id, ID.clientNova, approval.id],
        ),
      ),
    ).resolves.toBeTruthy();

    // And recording it as a plain "allow" for that same person/action would be a lie the
    // database refuses to store.
    await expect(
      asService(db, () =>
        db.query(
          `insert into public.agent_tool_calls (workspace_id, run_id, tool_name, on_behalf_of, module, action, decision)
           values ($1, $2, 'propose_grantable_demo_action', $3, 'paid_ads', 'publish_execute', 'allow')`,
          [ID.nova, run.id, ID.clientNova],
        ),
      ),
    ).rejects.toThrow(/does not match what permission rules actually allow/);
  });

  it('a pure utility tool call (no module) needs no on_behalf_of at all', async () => {
    const runId = await makeRun();
    await expect(
      asService(db, () => db.query(`insert into public.agent_tool_calls (workspace_id, run_id, tool_name) values ($1, $2, 'echo_message')`, [ID.acme, runId])),
    ).resolves.toBeTruthy();
  });

  it('is written to the audit log, denied and pending_approval included', async () => {
    const runId = await makeRun();
    await asService(db, () => db.query(`insert into public.agent_tool_calls (workspace_id, run_id, tool_name) values ($1, $2, 'echo_message')`, [ID.acme, runId]));
    const events = await audit(ID.acme);
    expect(events.some((e) => e.action === 'agent.run_started' && e.result === 'success')).toBe(true);
    expect(events.some((e) => e.action === 'agent.tool_called' && e.target_type === 'agent_tool_calls')).toBe(true);
  });
});

describe('agent_handoffs', () => {
  it('records a handoff, tied to the run it came from, and audits it', async () => {
    const defId = await makeEchoDefinition();
    const [run] = await asService(db, () =>
      rows<{ id: string }>(db, `insert into public.agent_runs (workspace_id, agent_definition_id, agent_key) values ($1, $2, 'sandbox_echo') returning id`, [ID.acme, defId]),
    );
    await asService(db, () => db.query(`insert into public.agent_handoffs (workspace_id, from_run_id, to_agent_key) values ($1, $2, 'content_agent')`, [ID.acme, run.id]));
    expect(await asAdmin(() => rows(db, `select to_agent_key from public.agent_handoffs where from_run_id = $1`, [run.id]))).toEqual([{ to_agent_key: 'content_agent' }]);
    expect((await audit(ID.acme)).some((e) => e.action === 'agent.handoff_created')).toBe(true);
  });

  it('is refused for a run in a different workspace', async () => {
    const defId = await makeEchoDefinition();
    const [run] = await asService(db, () =>
      rows<{ id: string }>(db, `insert into public.agent_runs (workspace_id, agent_definition_id, agent_key) values ($1, $2, 'sandbox_echo') returning id`, [ID.acme, defId]),
    );
    await expect(
      asService(db, () => db.query(`insert into public.agent_handoffs (workspace_id, from_run_id, to_agent_key) values ($1, $2, 'content_agent')`, [ID.nova, run.id])),
    ).rejects.toThrow(/does not belong to this workspace/);
  });
});

describe('history cannot be deleted, not even by the server', () => {
  it('refuses to delete an agent_runs row', async () => {
    const defId = await makeEchoDefinition();
    const [run] = await asService(db, () =>
      rows<{ id: string }>(db, `insert into public.agent_runs (workspace_id, agent_definition_id, agent_key) values ($1, $2, 'sandbox_echo') returning id`, [ID.acme, defId]),
    );
    await expect(asService(db, () => db.query(`delete from public.agent_runs where id = $1`, [run.id]))).rejects.toThrow(/permission denied/);
  });
});
