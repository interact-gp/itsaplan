import { beforeEach, describe, expect, it } from 'bun:test';
import { auth } from '@repo/auth';
import { app, authedApi } from '#tests/helpers/app';
import { resetDb } from '#tests/helpers/db';
import { signUpTestUser } from '#tests/helpers/auth';
import { createAgent, setAgentProjectRole, teamOf } from '#tests/helpers/agents';
import { createRole } from '#tests/helpers/roles';
import { getAgentById, getInternalAgentApiKey } from '#modules/agents/core/service';
import { authorizedTools } from '../../catalogue';
import { routeTools } from '../../generate';

// Agent management is a team operation, but an MCP client knows only projects. The
// team is resolved from the key instead of asked for; this covers who gets to name
// one and who must not.

async function rpc(apiKey: string, method: string, params: Record<string, unknown> = {}) {
  const res = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  // The transport answers over SSE: one `data:` line carrying the JSON-RPC response.
  const text = await res.text();
  return JSON.parse(text.slice(text.indexOf('data: ') + 6)).result;
}

async function toolNamed(apiKey: string, name: string) {
  const { tools } = await rpc(apiKey, 'tools/list');
  return tools.find((tool: { name: string }) => tool.name === name);
}

async function call(apiKey: string, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(apiKey, 'tools/call', { name, arguments: args });
  return { text: result.content[0].text as string, isError: result.isError === true };
}

// A user, their first team, and the key of an internal agent living in it. The agent
// works in MKT on a role that may manage agents, which is what these tools need.
async function setup() {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await asOwner.projects.post({ key: 'MKT', name: 'Marketing' });
  const teamId = await teamOf(asOwner, 'MKT');
  const role = await createRole(asOwner, 'MKT', {
    name: 'Agent Admin',
    permissions: { ai_agents: { create: true, read: true, edit: true, delete: true } },
  });
  const roleId = role.data!.id;
  const created = await createAgent(asOwner, 'MKT', {
    name: 'Triage Bot',
    username: 'triage',
    kind: 'internal',
  });
  await setAgentProjectRole(asOwner, 'MKT', created.data!.agent.userId, roleId);
  const agent = await getAgentById(created.data!.agent.id, teamId);
  return { owner, asOwner, teamId, roleId, agentKey: await getInternalAgentApiKey(agent!) };
}

describe('MCP team resolution', () => {
  beforeEach(resetDb);

  it('takes the team of an agent key from its agent and does not ask for one', async () => {
    const { agentKey, teamId, roleId, asOwner } = await setup();

    expect(
      Object.keys((await toolNamed(agentKey, 'create_ai_agent')).inputSchema.properties),
    ).not.toContain('teamId');

    const { isError } = await call(agentKey, 'create_ai_agent', {
      name: 'Second Bot',
      username: 'second',
      kind: 'external',
      roleId,
    });
    expect(isError).toBe(false);

    const listed = await asOwner.teams({ teamId })['ai-agents'].get();
    expect(listed.data!.map((a) => a.username)).toContain('second');
  });

  it('keeps an agent key in its own team when it names another', async () => {
    const { agentKey, roleId } = await setup();
    const other = await signUpTestUser({ name: 'Other', email: 'other@example.com' });
    const asOther = authedApi(other.cookie);
    await asOther.projects.post({ key: 'OPS', name: 'Ops' });
    const otherTeam = await teamOf(asOther, 'OPS');

    await call(agentKey, 'create_ai_agent', {
      teamId: otherTeam,
      name: 'Intruder',
      username: 'intruder',
      kind: 'external',
      roleId,
    });

    const listed = await asOther.teams({ teamId: otherTeam })['ai-agents'].get();
    expect(listed.data!.map((a) => a.username)).not.toContain('intruder');
  });

  it('asks a person in more than one team to name the team', async () => {
    const { owner, asOwner, agentKey } = await setup();
    await asOwner.teams.post({ name: 'Second Team' });
    const personKey = (await auth.api.createApiKey({ body: { userId: owner.userId, name: 'mcp' } }))
      .key;

    expect(
      Object.keys((await toolNamed(personKey, 'list_ai_agents')).inputSchema.properties),
    ).toContain('teamId');

    const { text, isError } = await call(personKey, 'list_ai_agents');
    expect(isError).toBe(true);
    expect(text).toContain('teamId');

    // The agent's own key is unaffected: it belongs to one team either way.
    expect((await call(agentKey, 'list_ai_agents')).isError).toBe(false);
  });

  it('lists the teams of the caller', async () => {
    const { owner, asOwner } = await setup();
    await asOwner.teams.post({ name: 'Second Team' });
    const personKey = (await auth.api.createApiKey({ body: { userId: owner.userId, name: 'mcp' } }))
      .key;

    const { text } = await call(personKey, 'list_teams');
    expect(JSON.parse(text).map((team: { name: string }) => team.name)).toContain('Second Team');
  });
});

describe('MCP planning discovery', () => {
  beforeEach(resetDb);

  it('limits fallback recommendations to the caller and rejects another project scope', async () => {
    const owner = await signUpTestUser({ name: 'Owner' });
    const asOwner = authedApi(owner.cookie);
    const project = await asOwner.projects.post({ key: 'MKT', name: 'Marketing' });
    const other = await signUpTestUser({ name: 'Other', email: 'other@example.com' });
    const foreign = await authedApi(other.cookie).projects.post({ key: 'OPS', name: 'Ops' });
    const key = (await auth.api.createApiKey({ body: { userId: owner.userId, name: 'discovery' } }))
      .key;
    const previousKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = await call(key, 'discover_tools', {
        request: 'create issue',
        projectId: project.data!.id,
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.text);
      expect(payload.source).toBe('fallback');
      expect(payload.tools.map((tool: { name: string }) => tool.name)).toContain('create_issue');
      expect(
        payload.tools.every(
          (tool: { name: string }) =>
            !tool.name.includes('agent') && !tool.name.includes('credential'),
        ),
      ).toBe(true);
      const denied = await call(key, 'discover_tools', {
        request: 'create issue',
        projectId: foreign.data!.id,
      });
      const missing = await call(key, 'discover_tools', {
        request: 'create issue',
        projectId: 999999,
      });
      expect(denied.isError).toBe(true);
      expect(denied.text).toBe(missing.text);
      expect((await call(key, 'discover_tools', { request: '   ' })).isError).toBe(true);
    } finally {
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });

  it('filters custom project permissions and disabled project features before ranking', async () => {
    const { owner: projectOwner, asOwner, agentKey } = await setup();
    const project = await asOwner.projects({ projectKey: 'MKT' }).get();
    const agent = (await asOwner.teams({ teamId: await teamOf(asOwner, 'MKT') })['ai-agents'].get())
      .data![0]!;
    const candidates = await authorizedTools(routeTools(app), agent.userId, {
      projectId: project.data!.project.id,
    });
    expect(candidates.map((tool) => tool.name)).not.toContain('create_issue');
    expect(candidates.map((tool) => tool.name)).not.toContain('delete_project');
    const updated = await asOwner
      .projects({ projectKey: 'MKT' })
      .settings.patch({ features: { dashboards: false } });
    expect(updated.status).toBe(200);
    const disabled = await authorizedTools(routeTools(app), projectOwner.userId, {
      projectId: project.data!.project.id,
    });
    expect(disabled.map((tool) => tool.name)).not.toContain('create_dashboard');
    const owner = await signUpTestUser({ name: 'Separate', email: 'separate@example.com' });
    const own = await authedApi(owner.cookie).projects.post({ key: 'OWN', name: 'Own' });
    const enabled = await authorizedTools(routeTools(app), owner.userId, {
      projectId: own.data!.id,
    });
    expect(enabled.map((tool) => tool.name)).toContain('create_dashboard');
    const keyResult = await call(agentKey, 'discover_tools', {
      request: 'create issue',
      projectId: own.data!.id,
    });
    expect(keyResult.isError).toBe(true);
  });

  it('does not recommend project tools after the team MCP switch is disabled', async () => {
    const owner = await signUpTestUser({ name: 'Owner' });
    const client = authedApi(owner.cookie);
    const project = await client.projects.post({ key: 'MKT', name: 'Marketing' });
    const teamId = await teamOf(client, 'MKT');
    const key = (await auth.api.createApiKey({ body: { userId: owner.userId, name: 'discovery' } }))
      .key;
    const updated = await client.teams({ teamId }).mcp.patch({ enabled: false });
    expect(updated.status).toBe(200);
    const result = await call(key, 'discover_tools', {
      request: 'create issue',
      projectId: project.data!.id,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Discovery scope not found');
  });
});
