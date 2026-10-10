import assert from 'node:assert/strict';
import { auth } from '../../packages/auth/src/index';
import { db } from '../../packages/db/src/index';
import {
  setApplicationAccess,
  syncKeycloakAccess,
} from '../../apps/api/src/modules/organization/keycloak';

if (
  process.env.API_URL !== 'http://localhost:13000' ||
  !process.env.DATABASE_URL?.endsWith('/itsaplan_v1')
)
  throw new Error('This check is restricted to the disposable local V1 environment');
await syncKeycloakAccess();
const people = await Promise.all(
  ['admin@frnd.app', 'member@frnd.app'].map((email) =>
    db.query.user.findFirst({ where: (user, { eq }) => eq(user.email, email) }),
  ),
);
assert(people[0] && people[1]);
const admin = (
  await auth.api.createApiKey({
    body: { name: 'Local runtime check', userId: people[0].id, expiresIn: 86400 },
  })
).key;
const member = (
  await auth.api.createApiKey({
    body: { name: 'Local runtime check', userId: people[1].id, expiresIn: 86400 },
  })
).key;

async function rest(key: string, path: string) {
  return fetch(`http://localhost:13000${path}`, { headers: { 'x-api-key': key } });
}
interface Rpc {
  result?: {
    tools?: { name: string }[];
    isError?: boolean;
    structuredContent?: { status: number; data: { id: number } };
  };
  error?: unknown;
}
async function rpc(key: string, method: string, params?: unknown) {
  const response = await fetch('http://localhost:13000/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  return JSON.parse(body.slice(body.indexOf('data: ') + 6)) as Rpc;
}
const tools = (await rpc(member, 'tools/list')).result!.tools!.map((tool) => tool.name);
assert(!tools.includes('create_team'));
assert(!tools.includes('set_application_access'));
const created = await rpc(admin, 'tools/call', {
  name: 'create_team',
  arguments: { name: `Local runtime pod ${Date.now()}` },
});
assert.equal(created.result!.structuredContent!.status, 201);
const teamId = created.result!.structuredContent!.data.id;
const custom = await rpc(admin, 'tools/call', {
  name: 'create_role',
  arguments: { teamId, name: 'Project creator', permissions: { projects: { create: true } } },
});
assert.equal(custom.result!.structuredContent!.status, 201);
const roleId = custom.result!.structuredContent!.data.id;
const added = await rpc(admin, 'tools/call', {
  name: 'add_team_member',
  arguments: { teamId, email: 'member@frnd.app', role: 'member', roleId },
});
assert.equal(added.result!.structuredContent!.status, 200);
const delegated = (await rpc(member, 'tools/list')).result!.tools!.map((tool) => tool.name);
assert(delegated.includes('create_team_project'));
const project = await rpc(member, 'tools/call', {
  name: 'create_team_project',
  arguments: {
    teamId,
    key: `R${Date.now().toString().slice(-8)}`,
    name: 'Delegated runtime project',
  },
});
assert.equal(project.result!.structuredContent!.status, 201);
await setApplicationAccess('member@frnd.app', 'none', people[0].id);
try {
  assert.equal((await rest(member, '/teams')).status, 401);
  const response = await fetch('http://localhost:13000/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${member}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert([401, 403].includes(response.status));
} finally {
  await setApplicationAccess('member@frnd.app', 'member', people[0].id);
}
assert.equal((await rest(member, '/teams')).status, 200);
const secrets = (await Bun.file('.local/v1/secrets.json').json()) as { provisioner: string };
const issuer = 'http://localhost:18080/realms/itsaplan-local';
const tokenResponse = await fetch(`${issuer}/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({
    client_id: 'itsaplan-provisioner',
    client_secret: secrets.provisioner,
    grant_type: 'client_credentials',
  }),
});
assert.equal(tokenResponse.status, 200);
const serviceToken = ((await tokenResponse.json()) as { access_token: string }).access_token;
async function keycloak(path: string, method = 'GET') {
  return fetch(`http://localhost:18080/admin/realms/itsaplan-local${path}`, {
    method,
    headers: { authorization: `Bearer ${serviceToken}` },
  });
}
const group = (await (await keycloak('/group-by-path/access/frnd-prd/member')).json()) as {
  id: string;
};
const [identity] = (await (
  await keycloak('/users?email=newmember%40frnd.app&exact=true')
).json()) as { id: string }[];
assert(identity);
const newMember = await db.query.user.findFirst({
  where: (user, { eq }) => eq(user.email, 'newmember@frnd.app'),
});
assert(newMember);
const newKey = (
  await auth.api.createApiKey({
    body: { name: 'Local polling check', userId: newMember.id, expiresIn: 86400 },
  })
).key;
async function waitForStatus(expected: number) {
  const started = Date.now();
  while (Date.now() - started < 35_000) {
    if ((await rest(newKey, '/teams')).status === expected) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Background synchronization did not produce HTTP ${expected}`);
}
assert.equal((await rest(newKey, '/teams')).status, 200);
assert.equal((await keycloak(`/users/${identity.id}/groups/${group.id}`, 'DELETE')).status, 204);
try {
  const delay = await waitForStatus(401);
  console.log(
    `PASS: direct Keycloak membership removal reached the running API through background polling in ${delay} ms.`,
  );
} finally {
  assert.equal((await keycloak(`/users/${identity.id}/groups/${group.id}`, 'PUT')).status, 204);
  await waitForStatus(200);
}
console.log(
  'PASS: real Keycloak synchronization, admin-only catalogue, native MCP team/role/member/project creation, revocation of existing API and MCP credentials, and access restoration.',
);
process.exit(0);
