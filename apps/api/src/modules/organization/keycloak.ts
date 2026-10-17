import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  db,
  getSetting,
  managedAccess,
  organizationAccess,
  organizationGroups,
  scimGroup,
  scimGroupMember,
  setSetting,
  appSetting,
  user,
} from '@repo/db';
import { createScimUser } from '#modules/scim/service';
import { HttpError } from '#shared/lib';

function configuration() {
  const issuer = process.env.ITSAPLAN_KEYCLOAK_ISSUER;
  const clientId = process.env.ITSAPLAN_KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.ITSAPLAN_KEYCLOAK_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret)
    throw new Error('Keycloak provisioning is not configured');
  const url = new URL(issuer);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/realms\/[^/]+$/.test(url.pathname) ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  ) {
    throw new Error('Keycloak requires HTTPS');
  }
  return { issuer, clientId, clientSecret, adminUrl: issuer.replace('/realms/', '/admin/realms/') };
}

async function adminClient() {
  const config = configuration();
  const response = await fetch(`${config.issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Keycloak service authentication failed (${response.status})`);
  const { access_token: token } = (await response.json()) as { access_token?: string };
  if (!token) throw new Error('Keycloak did not issue a service token');
  return async <T = unknown>(path: string, method = 'GET'): Promise<T> => {
    const result = await fetch(config.adminUrl + path, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok) throw new Error(`Keycloak provisioning failed (${result.status})`);
    return (result.status === 204 ? null : await result.json()) as T;
  };
}

async function applicationGroups(request: Awaited<ReturnType<typeof adminClient>>) {
  const ids = {
    admin: process.env.ITSAPLAN_KEYCLOAK_ADMIN_GROUP_ID?.trim(),
    member: process.env.ITSAPLAN_KEYCLOAK_MEMBER_GROUP_ID?.trim(),
  };
  if (Boolean(ids.admin) !== Boolean(ids.member))
    throw new Error('Configure both Keycloak application group IDs or neither');
  const groups = {} as Record<keyof typeof organizationGroups, { id: string; path: string }>;
  for (const rank of ['admin', 'member'] as const) {
    const path = organizationGroups[rank];
    const id = ids[rank];
    const group = await request<{ id: string; path: string }>(
      id ? `/groups/${encodeURIComponent(id)}` : `/group-by-path${path}`,
    );
    if (!group.id || group.path !== path || (id && group.id !== id))
      throw new Error(`Keycloak ${rank} group does not match its configured identity and path`);
    groups[rank] = group;
  }
  return groups;
}

interface Person {
  id: string;
  email: string;
  emailVerified: boolean;
  enabled: boolean;
  firstName?: string;
  lastName?: string;
}

let accessQueue: Promise<unknown> = Promise.resolve();

function serializeAccess<T>(operation: () => Promise<T>): Promise<T> {
  const result = accessQueue.then(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(731926104)`);
      return operation();
    }),
  );
  accessQueue = result.catch(() => undefined);
  return result;
}

export function syncKeycloakAccess() {
  return serializeAccess(synchronize);
}

async function synchronize() {
  if (!managedAccess()) return;
  const request = await adminClient();
  const desired = new Map<string, { person: Person; groups: string[] }>();
  const groups = await applicationGroups(request);
  for (const group of Object.values(groups)) {
    for (let offset = 0; ; offset += 100) {
      const people: Person[] = await request<Person[]>(
        `/groups/${group.id}/members?first=${offset}&max=100`,
      );
      for (const person of people) {
        if (
          !person.emailVerified ||
          !person.enabled ||
          !person.email?.toLowerCase().endsWith('@frnd.app')
        )
          continue;
        const entry = desired.get(person.id) ?? { person, groups: [] };
        entry.groups.push(group.path);
        desired.set(person.id, entry);
      }
      if (people.length < 100) break;
    }
  }
  const assignments: { id: string; groups: string[]; email: string }[] = [];
  for (const { person, groups } of desired.values()) {
    const [existing] = await db.select().from(user).where(eq(user.scimExternalId, person.id));
    if (existing?.role === 'god' || (existing && !existing.emailVerified)) {
      desired.delete(person.id);
      continue;
    }
    let id = existing?.id;
    if (!id) {
      const email = person.email.toLowerCase();
      const [matching] = await db.select().from(user).where(eq(user.email, email));
      if (
        matching &&
        (matching.role === 'god' || !matching.emailVerified || matching.scimExternalId)
      ) {
        desired.delete(person.id);
        continue;
      }
      const created = await createScimUser({
        email,
        name: [person.firstName, person.lastName].filter(Boolean).join(' ') || email,
        active: true,
        externalId: person.id,
      });
      id = created.id;
    }
    assignments.push({ id, groups, email: person.email.toLowerCase() });
  }
  const previous = (await getSetting<string[]>('organization.subjects')) ?? [];
  const managed = previous.length
    ? await db
        .select({ id: user.id, sub: user.scimExternalId })
        .from(user)
        .where(and(eq(user.role, 'user'), inArray(user.scimExternalId, previous)))
    : [];
  const removed = managed
    .filter((person) => person.sub && !desired.has(person.sub))
    .map((person) => person.id);
  const activeIds = assignments.map((entry) => entry.id);
  await db.transaction(async (tx) => {
    for (const name of Object.values(organizationGroups)) {
      await tx.insert(scimGroup).values({ displayName: name }).onConflictDoNothing();
    }
    const groups = await tx
      .select()
      .from(scimGroup)
      .where(inArray(scimGroup.displayName, Object.values(organizationGroups)));
    const affected = [...activeIds, ...removed];
    if (affected.length)
      await tx.delete(scimGroupMember).where(
        and(
          inArray(scimGroupMember.userId, affected),
          inArray(
            scimGroupMember.groupId,
            groups.map((group) => group.id),
          ),
        ),
      );
    const memberships = assignments.flatMap((entry) =>
      groups
        .filter((group) => entry.groups.includes(group.displayName))
        .map((group) => ({ groupId: group.id, userId: entry.id })),
    );
    if (memberships.length) await tx.insert(scimGroupMember).values(memberships);
    for (const entry of assignments) {
      await tx
        .update(user)
        .set({ active: true, email: entry.email })
        .where(and(eq(user.role, 'user'), eq(user.id, entry.id)));
    }
    if (removed.length)
      await tx
        .update(user)
        .set({ active: false })
        .where(and(eq(user.role, 'user'), inArray(user.id, removed)));
    for (const [key, value] of [
      ['organization.subjects', [...desired.keys()]],
      ['organization.lastSync', Date.now()],
    ] as const) {
      await tx
        .insert(appSetting)
        .values({ key, value })
        .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: new Date() } });
    }
  });
}

export function setApplicationAccess(
  email: string,
  role: 'admin' | 'member' | 'none',
  actorId: string,
) {
  return serializeAccess(() => changeApplicationAccess(email, role, actorId));
}

async function changeApplicationAccess(
  email: string,
  role: 'admin' | 'member' | 'none',
  actorId: string,
) {
  if (!managedAccess()) throw new HttpError(400, 'Managed access is disabled');
  const [actor] = await db.select().from(user).where(eq(user.id, actorId));
  if (
    !actor ||
    actor.active === false ||
    (actor.role !== 'god' && !(await organizationAccess(actorId)).admin)
  )
    throw new HttpError(403, 'Only an organization admin can do this');
  const request = await adminClient();
  const people: Person[] = await request<Person[]>(
    `/users?email=${encodeURIComponent(email.toLowerCase())}&exact=true`,
  );
  if (
    people.length !== 1 ||
    (role !== 'none' && (!people[0]?.enabled || !people[0]?.emailVerified)) ||
    people[0].email?.toLowerCase() !== email.toLowerCase() ||
    !people[0].email.toLowerCase().endsWith('@frnd.app')
  ) {
    throw new HttpError(400, 'An enabled, verified company identity is required');
  }
  if (
    actor.scimExternalId === people[0].id ||
    actor.email.toLowerCase() === people[0].email.toLowerCase()
  )
    throw new HttpError(409, 'You cannot change your own application access');
  const [owner] = await db
    .select({ role: user.role })
    .from(user)
    .where(
      or(eq(user.scimExternalId, people[0].id), eq(user.email, people[0].email.toLowerCase())),
    );
  if (owner?.role === 'god') throw new HttpError(409, 'The instance owner cannot be provisioned');
  const groups = await applicationGroups(request);
  const admins: Person[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await request<Person[]>(
      `/groups/${groups.admin.id}/members?first=${offset}&max=100`,
    );
    admins.push(
      ...page.filter(
        (person) =>
          person.enabled &&
          person.emailVerified &&
          person.email?.toLowerCase().endsWith('@frnd.app'),
      ),
    );
    if (page.length < 100) break;
  }
  if (role !== 'admin' && admins.length === 1 && admins[0]?.id === people[0].id) {
    throw new HttpError(409, 'The last organization admin cannot be removed');
  }
  await setSetting('organization.lastSync', 0);
  for (const [rank, group] of Object.entries(groups)) {
    await request(`/users/${people[0].id}/groups/${group.id}`, rank === role ? 'PUT' : 'DELETE');
  }
  await synchronize();
  return { role };
}
