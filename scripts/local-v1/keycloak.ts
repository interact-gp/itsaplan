export {};

interface Representation {
  id: string;
  name: string;
  email: string;
  enabled: boolean;
  adminPermissionsEnabled?: boolean;
  attributes?: Record<string, string>;
}

const base = 'http://localhost:18080';
const realm = 'itsaplan-local';
const secrets = await Bun.file('.local/v1/secrets.json').json();

async function token(clientId: string, fields: Record<string, string>) {
  const response = await fetch(
    `${base}/realms/${clientId === 'admin-cli' ? 'master' : realm}/protocol/openid-connect/token`,
    {
      method: 'POST',
      body: new URLSearchParams({ client_id: clientId, ...fields }),
    },
  );
  if (!response.ok) throw new Error(`Local service authentication: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}
const admin = await token('admin-cli', {
  grant_type: 'password',
  username: 'local-admin',
  password: secrets.keycloak,
});
async function request<T = Representation>(
  path: string,
  method = 'GET',
  body?: unknown,
  credential = admin,
): Promise<T> {
  const response = await fetch(`${base}/admin/realms/${realm}${path}`, {
    method,
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Local Keycloak ${method} ${path}: ${response.status}`);
  return (
    response.status === 204 || response.headers.get('content-length') === '0'
      ? undefined
      : await response.json()
  ) as T;
}
await request('', 'PUT', { adminPermissionsEnabled: true });
async function client(name: string) {
  const clients = await request<Representation[]>(`/clients?clientId=${encodeURIComponent(name)}`);
  if (clients.length !== 1) throw new Error(`Expected one local client: ${name}`);
  return clients[0]!;
}
const provisioner = await client('itsaplan-provisioner');
const service = await request(`/clients/${provisioner.id}/service-account-user`);
const management = await client('realm-management');
const permissions = await client('admin-permissions');
const root = `/clients/${permissions.id}/authz/resource-server`;
const policies: string[] = [];
for (const policy of [
  { name: 'itsaplan-local-provisioner-client', type: 'client', clients: [provisioner.id] },
  { name: 'itsaplan-local-provisioner-user', type: 'user', users: [service.id] },
]) {
  const existing = await request<Representation[]>(`${root}/policy?name=${policy.name}`);
  const body = { ...policy, logic: 'POSITIVE', decisionStrategy: 'UNANIMOUS' };
  if (existing.length) {
    policies.push(existing[0]!.id);
    await request(`${root}/policy/${policy.type}/${existing[0]!.id}`, 'PUT', {
      ...body,
      id: existing[0]!.id,
    });
  } else {
    policies.push((await request(`${root}/policy/${policy.type}`, 'POST', body)).id);
  }
}
const groups = await Promise.all(
  ['admin', 'member'].map((rank) => request(`/group-by-path/access/frnd-prd/${rank}`)),
);
for (const permission of [
  {
    name: 'itsaplan-local-users',
    resourceType: 'Users',
    resources: [],
    scopes: ['view', 'manage-group-membership'],
  },
  {
    name: 'itsaplan-local-groups',
    resourceType: 'Groups',
    scopes: ['view', 'view-members', 'manage-membership'],
    resources: groups.map((g) => g.id),
  },
]) {
  const matches = (
    await request<Representation[]>(`${root}/permission?name=${permission.name}`)
  ).filter((p: { name: string }) => p.name === permission.name);
  const body = {
    ...permission,
    type: 'scope',
    logic: 'POSITIVE',
    policies,
    decisionStrategy: 'AFFIRMATIVE',
  };
  if (matches.length)
    await request(`${root}/permission/scope/${matches[0]!.id}`, 'PUT', {
      ...body,
      id: matches[0]!.id,
    });
  else await request(`${root}/permission/scope`, 'POST', body);
}
const mappingPath = `/users/${service.id}/role-mappings/clients/${management.id}`;
const mappings = await request<Representation[]>(mappingPath);
if (mappings.length) await request(mappingPath, 'DELETE', mappings);
const queryRoles = await Promise.all(
  ['query-users', 'query-groups'].map((name) => request(`/clients/${management.id}/roles/${name}`)),
);
await request(mappingPath, 'POST', queryRoles);
for (const [name, origin, redirect] of [
  ['itsaplan-web', 'http://localhost:3001', 'http://localhost:13000/api/auth/oauth2/callback/oidc'],
  ['shastra-local-browser', 'http://localhost:18082', 'http://localhost:18082/callback'],
] as const) {
  const configured = await client(name);
  await request(`/clients/${configured.id}`, 'PUT', {
    ...configured,
    redirectUris: [redirect],
    webOrigins: [origin],
    attributes: { ...configured.attributes, 'pkce.code.challenge.method': 'S256' },
  });
}
await request(`/clients/${provisioner.id}`, 'PUT', {
  ...provisioner,
  redirectUris: [],
  webOrigins: [],
});
const provisionerToken = await token('itsaplan-provisioner', {
  grant_type: 'client_credentials',
  client_secret: secrets.provisioner,
});
const target = (await request<Representation[]>('/users?username=denied&exact=true'))[0]!;
const unrelated = await request('/group-by-path/unrelated');
async function status(path: string, method: string, body?: unknown) {
  return (
    await fetch(`${base}/admin/realms/${realm}${path}`, {
      method,
      headers: { authorization: `Bearer ${provisionerToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  ).status;
}
const checks = {
  lookupCount: (
    await request<Representation[]>(
      `/users?email=${encodeURIComponent(target.email)}&exact=true`,
      'GET',
      undefined,
      provisionerToken,
    )
  ).length,
  memberCount: (
    await request<Representation[]>(
      `/groups/${groups[1]!.id}/members`,
      'GET',
      undefined,
      provisionerToken,
    )
  ).length,
  lookup: await status(`/users?email=${encodeURIComponent(target.email)}&exact=true`, 'GET'),
  allowedMembership: await status(`/users/${target.id}/groups/${groups[1].id}`, 'PUT'),
  unrelatedMembership: await status(`/users/${target.id}/groups/${unrelated.id}`, 'PUT'),
  editIdentity: await status(`/users/${target.id}`, 'PUT', { enabled: target.enabled }),
  mapRealmAdmin: await status(
    `/users/${target.id}/role-mappings/clients/${management.id}`,
    'POST',
    [await request(`/clients/${management.id}/roles/manage-users`)],
  ),
};
await request(`/users/${target.id}/groups/${groups[1].id}`, 'DELETE');
await request(`/users/${target.id}/groups/${unrelated.id}`, 'DELETE');
await request(`/users/${target.id}/role-mappings/clients/${management.id}`, 'DELETE', [
  await request(`/clients/${management.id}/roles/manage-users`),
]);
console.log(JSON.stringify(checks));
if (
  checks.lookupCount !== 1 ||
  checks.memberCount < 2 ||
  checks.lookup !== 200 ||
  checks.allowedMembership !== 204 ||
  checks.unrelatedMembership !== 403 ||
  checks.editIdentity !== 403 ||
  checks.mapRealmAdmin !== 403
)
  throw new Error('Local provisioner least privilege verification failed');
