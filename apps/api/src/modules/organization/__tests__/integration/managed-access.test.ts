import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  db,
  organizationAccess,
  organizationGroups,
  scimGroup,
  scimGroupMember,
  setSetting,
  teamMember,
  user,
} from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { app, authedApi, apiKeyApi } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { createScimUser } from '#modules/scim/service';
import { auth } from '@repo/auth';
import { syncKeycloakAccess, setApplicationAccess } from '../../keycloak';

async function grant(userId: string, rank: 'admin' | 'member') {
  const [group] = await db
    .insert(scimGroup)
    .values({ displayName: organizationGroups[rank] })
    .onConflictDoUpdate({
      target: scimGroup.displayName,
      set: { displayName: organizationGroups[rank] },
    })
    .returning();
  await db.insert(scimGroupMember).values({ groupId: group!.id, userId }).onConflictDoNothing();
  await setSetting('organization.lastSync', Date.now());
}

async function keyFor(userId: string) {
  return (await auth.api.createApiKey({ body: { name: 'Managed regression', userId } })).key;
}

async function rpc(key: string, method: string, params = {}) {
  return app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
}

async function listed(key: string) {
  const response = await rpc(key, 'tools/list');
  const body = await response.text();
  const data = JSON.parse(body.slice(body.indexOf('data: ') + 6));
  return data.result.tools.map((tool: { name: string }) => tool.name) as string[];
}

describe('managed organization access', () => {
  const keycloakEnv = {
    ITSAPLAN_KEYCLOAK_ISSUER: 'https://keycloak.invalid/realms/test',
    ITSAPLAN_KEYCLOAK_CLIENT_ID: 'test-client',
    ITSAPLAN_KEYCLOAK_CLIENT_SECRET: 'test-secret',
    ITSAPLAN_KEYCLOAK_ADMIN_GROUP_ID: '',
    ITSAPLAN_KEYCLOAK_MEMBER_GROUP_ID: '',
  };
  const originalKeycloakEnv = Object.fromEntries(
    Object.keys(keycloakEnv).map((key) => [key, process.env[key]]),
  );
  beforeEach(async () => {
    process.env.ITSAPLAN_MANAGED_ACCESS = 'false';
    Object.assign(process.env, keycloakEnv);
    await resetDb();
  });
  afterEach(() => {
    process.env.ITSAPLAN_MANAGED_ACCESS = 'false';
    for (const [key, value] of Object.entries(originalKeycloakEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function actors() {
    await signUpTestUser();
    const admin = await signUpTestUser({ email: 'admin@frnd.app' });
    const member = await signUpTestUser({ email: 'member@frnd.app' });
    await db.delete(teamMember);
    process.env.ITSAPLAN_MANAGED_ACCESS = 'true';
    await grant(admin.userId, 'admin');
    await grant(member.userId, 'member');
    return {
      admin,
      member,
      adminApi: authedApi(admin.cookie),
      memberApi: authedApi(member.cookie),
    };
  }

  it('provisions an unassigned identity without creating a personal team', async () => {
    const { adminApi } = await actors();
    const teamsBefore = (await adminApi.teams.get()).data;
    const person = await createScimUser({
      email: 'new@frnd.app',
      name: 'New Member',
      active: true,
      externalId: 'new-subject',
    });
    expect(await db.select().from(teamMember).where(eq(teamMember.userId, person.id))).toHaveLength(
      0,
    );
    expect((await adminApi.teams.get()).data).toEqual(teamsBefore);
  });

  it('restricts team creation to organization admins and delegates projects through a team role', async () => {
    const { admin, member, adminApi, memberApi } = await actors();
    expect((await memberApi.organization.users.get()).status).toBe(403);
    await expect(
      setApplicationAccess('admin@frnd.app', 'admin', member.userId),
    ).rejects.toMatchObject({ status: 403 });
    expect((await memberApi.teams.post({ name: 'Forbidden' })).status).toBe(403);
    const memberKey = await keyFor(member.userId);
    const initialTools = await listed(memberKey);
    expect(initialTools).not.toContain('create_team');
    expect(initialTools).not.toContain('set_application_access');
    expect(initialTools).not.toContain('create_project');
    expect(initialTools).not.toContain('create_team_project');
    expect((await memberApi.projects.post({ key: 'NO', name: 'No team' })).status).toBe(400);
    const created = await adminApi.teams.post({ name: 'Mail retention' });
    expect(created.status).toBe(201);
    const teamId = created.data!.id;
    expect(await listed(await keyFor(admin.userId))).toContain('create_team_project');
    await adminApi.teams({ teamId }).projects.post({ key: 'PRIVATE', name: 'Private project' });
    const custom = await adminApi
      .teams({ teamId })
      .roles.post({ name: 'Project creator', permissions: { projects: { create: true } } });
    expect(custom.status).toBe(201);
    expect(
      (
        await adminApi
          .teams({ teamId })
          .members.post({ email: member.email, role: 'member', roleId: custom.data!.id })
      ).status,
    ).toBe(200);
    expect((await memberApi.teams({ teamId }).projects.get()).data?.items).toEqual([]);
    expect(await listed(memberKey)).toContain('create_team_project');
    expect((await memberApi.projects({ projectKey: 'PRIVATE' }).get()).status).toBe(403);
    expect(
      (await memberApi.teams({ teamId }).projects.post({ key: 'MINE', name: 'My project' })).status,
    ).toBe(201);
    await adminApi
      .teams({ teamId })
      .members({ userId: member.userId })
      .patch({ role: 'member', roleId: null });
    expect(
      (await memberApi.teams({ teamId }).projects.post({ key: 'NEXT', name: 'Denied' })).status,
    ).toBe(403);
    expect((await memberApi.projects({ projectKey: 'MINE' }).get()).status).toBe(200);
  });

  it('grants fresh organization admins full access without memberships and revokes existing credentials', async () => {
    const { admin, member, adminApi, memberApi } = await actors();
    const teamId = (await adminApi.teams.post({ name: 'Independent team' })).data!.id;
    const project = (
      await adminApi.teams({ teamId }).projects.post({ key: 'GLOBAL', name: 'Global access' })
    ).data!;
    await adminApi.teams({ teamId }).members.post({ email: member.email, role: 'owner' });
    await adminApi
      .projects({ projectKey: project.key })
      .members.post({ userId: member.userId, role: 'owner' });
    expect(
      (
        await adminApi
          .projects({ projectKey: project.key })
          .members({ userId: admin.userId })
          .delete()
      ).status,
    ).toBe(204);
    expect((await adminApi.teams({ teamId }).leave.post()).status).toBe(204);
    const key = await keyFor(admin.userId);
    await memberApi
      .projects({ projectKey: project.key })
      .settings.patch({ features: { documents: true, notes: true } });
    const document = (
      await memberApi
        .projects({ projectKey: project.key })
        .documents.post({ title: 'Private project document', isPrivate: true })
    ).data!;
    const board = (
      await memberApi
        .projects({ projectKey: project.key })
        ['note-boards'].post({ name: 'Private project board', visibility: 'private' })
    ).data!;
    expect(
      (await adminApi.projects({ projectKey: project.key }).documents.get({ query: {} })).data,
    ).toContainEqual(expect.objectContaining({ id: document.id }));
    expect(
      (
        await adminApi
          .projects({ projectKey: project.key })
          .documents({ documentId: document.id })
          .patch({ version: document.version, title: 'Admin edited private document' })
      ).status,
    ).toBe(200);
    expect(
      (await adminApi.projects({ projectKey: project.key })['note-boards'].get({ query: {} })).data,
    ).toContainEqual(expect.objectContaining({ id: board.id }));
    expect(
      (
        await adminApi
          .projects({ projectKey: project.key })
          ['note-boards']({ boardId: board.id })
          .patch({ name: 'Admin edited private board', visibility: 'restricted', memberIds: [] })
      ).status,
    ).toBe(200);
    const columnId = (await memberApi.projects({ projectKey: project.key }).get()).data!.columns[0]!
      .id;
    const watchedIssue = (
      await memberApi
        .projects({ projectKey: project.key })
        .issues.post({ title: 'Admin watching', columnId })
    ).data!;
    expect((await adminApi.issues({ issueId: watchedIssue.id }).watch.post()).status).toBe(200);
    expect(
      (await adminApi.issues({ issueId: watchedIssue.id }).get()).data?.watchers,
    ).toContainEqual(expect.objectContaining({ userId: admin.userId }));
    await memberApi
      .issues({ issueId: watchedIssue.id })
      .comments.post({ body: 'Update for the admin watcher' });
    expect(
      (await adminApi.notifications.get({ query: { types: 'commented' } })).data?.items,
    ).toContainEqual(expect.objectContaining({ issueId: watchedIssue.id }));
    expect((await adminApi.teams.get()).data).toContainEqual(
      expect.objectContaining({ id: teamId, role: 'owner' }),
    );
    expect((await adminApi.projects.get()).data).toContainEqual(
      expect.objectContaining({ id: project.id, role: 'owner' }),
    );
    expect((await adminApi.teams({ teamId }).get()).data?.permissions.projects.create).toBe(true);
    expect((await adminApi.projects({ projectKey: project.key }).get()).data?.viewer).toMatchObject(
      { role: 'owner', teamRole: 'owner' },
    );
    expect((await adminApi.god['auth-settings'].get()).status).toBe(200);
    expect((await memberApi.god['auth-settings'].get()).status).toBe(403);
    expect((await adminApi.teams({ teamId }).patch({ name: 'Renamed globally' })).status).toBe(200);
    expect(
      (await adminApi.projects({ projectKey: project.key }).patch({ name: 'Renamed project' }))
        .status,
    ).toBe(200);
    const colleague = await createScimUser({
      email: 'colleague@frnd.app',
      name: 'Colleague',
      active: true,
      externalId: 'colleague-subject',
    });
    await grant(colleague.id, 'member');
    await grant(member.userId, 'admin');
    const neverJoined = (await memberApi.teams.post({ name: 'Never joined by admin' })).data!.id;
    await db.delete(scimGroupMember).where(eq(scimGroupMember.userId, member.userId));
    await grant(member.userId, 'member');
    expect(
      (
        await adminApi
          .teams({ teamId: neverJoined })
          .members.post({ email: colleague.email, role: 'owner' })
      ).status,
    ).toBe(200);
    expect(
      (await adminApi.teams({ teamId }).members.post({ email: colleague.email, role: 'member' }))
        .status,
    ).toBe(200);
    expect(
      (await adminApi.teams({ teamId }).members({ userId: colleague.id }).patch({ role: 'owner' }))
        .status,
    ).toBe(204);
    expect(
      (await adminApi.teams({ teamId }).members({ userId: colleague.id }).patch({ role: 'member' }))
        .status,
    ).toBe(204);
    expect(
      (await adminApi.teams({ teamId }).members({ userId: colleague.id }).delete()).status,
    ).toBe(204);
    expect(
      (
        await adminApi
          .teams({ teamId })
          .roles.post({ name: 'Global role', permissions: { projects: { create: true } } })
      ).status,
    ).toBe(201);
    expect(
      (await adminApi.teams({ teamId }).projects.post({ key: 'GLOBAL2', name: 'Second' })).status,
    ).toBe(201);
    expect(
      (
        await adminApi
          .teams({ teamId })
          .members({ userId: member.userId })
          .patch({ role: 'member' })
      ).status,
    ).toBe(409);
    expect(
      (await adminApi.teams({ teamId }).members({ userId: member.userId }).delete()).status,
    ).toBe(409);
    expect(await listed(key)).toContain('create_team_project');
    const call = await rpc(key, 'tools/call', {
      name: 'get_project',
      arguments: { projectKey: project.key },
    });
    const text = await call.text();
    expect(JSON.parse(text.slice(text.indexOf('data: ') + 6)).result.structuredContent.status).toBe(
      200,
    );
    await adminApi.teams({ teamId }).mcp.patch({ enabled: false });
    const disabled = await rpc(key, 'tools/call', {
      name: 'get_project',
      arguments: { projectKey: project.key },
    });
    const disabledText = await disabled.text();
    expect(JSON.parse(disabledText.slice(disabledText.indexOf('data: ') + 6)).result.isError).toBe(
      true,
    );
    await adminApi.teams({ teamId }).mcp.patch({ enabled: true });
    await db.delete(scimGroupMember).where(eq(scimGroupMember.userId, admin.userId));
    await grant(admin.userId, 'member');
    expect((await adminApi.teams({ teamId }).get()).status).toBe(404);
    expect((await adminApi.projects({ projectKey: project.key }).get()).status).toBe(403);
    expect((await adminApi.god['auth-settings'].get()).status).toBe(403);
    expect((await apiKeyApi(key).projects({ projectKey: project.key }).get()).status).toBe(403);
    expect(
      (await memberApi.issues({ issueId: watchedIssue.id }).get()).data?.watchers,
    ).not.toContainEqual(expect.objectContaining({ userId: admin.userId }));
    expect(
      (await adminApi.notifications.get({ query: { types: 'commented' } })).data?.items,
    ).toEqual([]);
    expect(await listed(key)).not.toContain('create_team_project');
    expect(await listed(key)).not.toContain('create_team');
    const revoked = await rpc(key, 'tools/call', {
      name: 'get_project',
      arguments: { projectKey: project.key },
    });
    const revokedText = await revoked.text();
    expect(JSON.parse(revokedText.slice(revokedText.indexOf('data: ') + 6)).result.isError).toBe(
      true,
    );
    await grant(admin.userId, 'admin');
    await db.update(user).set({ active: false }).where(eq(user.id, admin.userId));
    expect(await organizationAccess(admin.userId)).toEqual({ enabled: false, admin: false });
    expect((await apiKeyApi(key).projects({ projectKey: project.key }).get()).status).toBe(401);
    await db.update(user).set({ active: true }).where(eq(user.id, admin.userId));
    await setSetting('organization.lastSync', Date.now() - 120_001);
    expect((await adminApi.projects({ projectKey: project.key }).get()).status).toBe(403);
  });

  it('assigns an owner when an administrator makes orphaned project content private', async () => {
    const { admin, member, adminApi, memberApi } = await actors();
    const teamId = (await adminApi.teams.post({ name: 'Content team' })).data!.id;
    const project = (
      await adminApi.teams({ teamId }).projects.post({ key: 'ORPHAN', name: 'Content recovery' })
    ).data!;
    await adminApi.teams({ teamId }).members.post({ email: member.email, role: 'member' });
    await adminApi
      .projects({ projectKey: project.key })
      .members.post({ userId: member.userId, role: 'member' });
    await adminApi
      .projects({ projectKey: project.key })
      .settings.patch({ features: { documents: true, notes: true } });
    const document = (
      await memberApi
        .projects({ projectKey: project.key })
        .documents.post({ title: 'Preserved document' })
    ).data!;
    const board = (
      await memberApi
        .projects({ projectKey: project.key })
        ['note-boards'].post({ name: 'Preserved board', visibility: 'public' })
    ).data!;
    expect((await adminApi.god.users({ userId: member.userId }).delete({ query: {} })).status).toBe(
      204,
    );
    const orphanedDocument = (
      await adminApi
        .projects({ projectKey: project.key })
        .documents({ documentId: document.id })
        .get()
    ).data!;
    expect(orphanedDocument.ownerUserId).toBeNull();
    const privateDocument = await adminApi
      .projects({ projectKey: project.key })
      .documents({ documentId: document.id })
      .access.post({ version: orphanedDocument.version, isPrivate: true });
    expect(privateDocument.status).toBe(200);
    expect(privateDocument.data).toMatchObject({ isPrivate: true, ownerUserId: admin.userId });
    const privateBoard = await adminApi
      .projects({ projectKey: project.key })
      ['note-boards']({ boardId: board.id })
      .patch({ visibility: 'private' });
    expect(privateBoard.status).toBe(200);
    expect(privateBoard.data).toMatchObject({ visibility: 'private', ownerUserId: admin.userId });
  });

  it('allows registered agents within their scope without granting human or administrator access', async () => {
    const { adminApi, member, memberApi } = await actors();
    const teamId = (await adminApi.teams.post({ name: 'Agent team' })).data!.id;
    const project = (
      await adminApi.teams({ teamId }).projects.post({ key: 'BOT', name: 'Agent project' })
    ).data!;
    await adminApi.teams({ teamId }).projects.post({ key: 'OTHER', name: 'Unassigned project' });
    const created = await adminApi.teams({ teamId })['ai-agents'].post({
      name: 'Managed bot',
      username: 'managedbot',
      kind: 'external',
      projectIds: [project.id],
    });
    expect(created.status).toBe(201);
    const { agent, apiKey } = created.data!;
    await grant(agent.userId, 'admin');
    const asAgent = apiKeyApi(apiKey!);
    expect((await asAgent.projects({ projectKey: 'BOT' }).get()).status).toBe(200);
    expect((await asAgent['agent-runs'].claim.post()).status).toBe(200);
    expect((await asAgent.projects({ projectKey: 'OTHER' }).get()).status).toBe(403);
    expect((await asAgent.organization.access.get()).data?.admin).toBe(false);
    expect((await asAgent.organization.users.get()).status).toBe(403);
    expect((await asAgent.teams.post({ name: 'Forbidden' })).status).toBe(403);
    const tools = await listed(apiKey!);
    expect(tools).toContain('get_project');
    expect(tools).not.toContain('create_team');
    expect(tools).not.toContain('set_application_access');
    const response = await rpc(apiKey!, 'tools/call', {
      name: 'get_project',
      arguments: { projectKey: 'BOT' },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    const result = JSON.parse(body.slice(body.indexOf('data: ') + 6)).result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent.status).toBe(200);

    await db.delete(scimGroupMember).where(eq(scimGroupMember.userId, member.userId));
    expect((await memberApi.teams.get()).status).toBe(403);
    expect((await rpc(await keyFor(member.userId), 'tools/list')).status).toBe(403);
    await db.update(user).set({ active: false }).where(eq(user.id, agent.userId));
    expect((await asAgent.projects({ projectKey: 'BOT' }).get()).status).toBe(401);
    expect((await asAgent['agent-runs'].claim.post()).status).toBe(401);
    expect((await rpc(apiKey!, 'tools/list')).status).toBe(401);
  });

  it('rejects custom roles from another team', async () => {
    const { member, adminApi } = await actors();
    const a = (await adminApi.teams.post({ name: 'A' })).data!.id;
    const b = (await adminApi.teams.post({ name: 'B' })).data!.id;
    const role = (
      await adminApi
        .teams({ teamId: b })
        .roles.post({ name: 'Foreign', permissions: { projects: { create: true } } })
    ).data!.id;
    expect(
      (
        await adminApi
          .teams({ teamId: a })
          .members.post({ email: member.email, role: 'member', roleId: role })
      ).status,
    ).toBe(400);
  });

  it('revokes existing cookies and MCP keys when entitlement is removed or stale', async () => {
    const { member, memberApi } = await actors();
    const key = await keyFor(member.userId);
    expect((await rpc(key, 'tools/list')).status).toBe(200);
    await db.delete(scimGroupMember).where(eq(scimGroupMember.userId, member.userId));
    expect((await memberApi.teams.get()).status).toBe(403);
    expect((await rpc(key, 'tools/list')).status).toBe(403);
    await grant(member.userId, 'member');
    await setSetting('organization.lastSync', Date.now() - 120_001);
    expect((await memberApi.teams.get()).status).toBe(403);
    expect((await rpc(key, 'tools/list')).status).toBe(403);
    await grant(member.userId, 'member');
    await db
      .update(user)
      .set({ active: false })
      .where(and(eq(user.id, member.userId), eq(user.role, 'user')));
    expect((await memberApi.teams.get()).status).toBe(401);
  });
  it('keeps an unverified legacy email collision unlinked and unauthorized', async () => {
    await signUpTestUser();
    const legacy = await signUpTestUser({ email: 'claimed@frnd.app' });
    const key = await keyFor(legacy.userId);
    const verified = await signUpTestUser({ email: 'verified@frnd.app' });
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, verified.userId));
    process.env.ITSAPLAN_MANAGED_ACCESS = 'true';
    const fixtureFetch = async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/token')) return Response.json({ access_token: 'fixture-token' });
      if (path.includes('/group-by-path/'))
        return Response.json({
          id: path.split('/').pop(),
          path: path.replace('/admin/realms/test/group-by-path', ''),
        });
      if (path.endsWith('/groups/admin/members')) return Response.json([]);
      if (path.endsWith('/groups/member/members'))
        return Response.json([
          { id: 'real-owner-sub', email: legacy.email, enabled: true, emailVerified: true },
          { id: 'verified-sub', email: verified.email, enabled: true, emailVerified: true },
        ]);
      throw new Error('Unexpected fixture request');
    };
    const mock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(fixtureFetch, { preconnect: globalThis.fetch.preconnect }),
    );
    try {
      await syncKeycloakAccess();
      expect(await organizationAccess(legacy.userId)).toEqual({ enabled: false, admin: false });
      expect((await authedApi(legacy.cookie).teams.get()).status).toBe(403);
      expect((await rpc(key, 'tools/list')).status).toBe(403);
      await expect(
        createScimUser({
          email: legacy.email,
          name: 'Real Owner',
          active: true,
          externalId: 'real-owner-sub',
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await db.query.user.findFirst({ where: eq(user.id, legacy.userId) })).toMatchObject({
        scimExternalId: null,
        emailVerified: false,
      });
      expect(await db.query.user.findFirst({ where: eq(user.id, verified.userId) })).toMatchObject({
        scimExternalId: 'verified-sub',
      });
      expect(await organizationAccess(verified.userId)).toEqual({ enabled: true, admin: false });
      await db
        .update(user)
        .set({ scimExternalId: 'real-owner-sub' })
        .where(eq(user.id, legacy.userId));
      await grant(legacy.userId, 'member');
      await setSetting('organization.subjects', ['real-owner-sub', 'verified-sub']);
      await syncKeycloakAccess();
      expect(await organizationAccess(legacy.userId)).toEqual({ enabled: false, admin: false });
      expect((await authedApi(legacy.cookie).teams.get()).status).toBe(401);
      expect((await rpc(key, 'tools/list')).status).toBe(401);
      expect(await organizationAccess(verified.userId)).toEqual({ enabled: true, admin: false });
    } finally {
      mock.mockRestore();
    }
  });

  it('reconciles Keycloak demotion, identity rename, and removal without changing resource memberships', async () => {
    const { admin, member, adminApi } = await actors();
    await db
      .update(user)
      .set({ scimExternalId: 'admin-sub', emailVerified: true })
      .where(eq(user.id, admin.userId));
    await db
      .update(user)
      .set({ scimExternalId: 'member-sub', emailVerified: true })
      .where(eq(user.id, member.userId));
    await setSetting('organization.subjects', ['admin-sub', 'member-sub']);
    const teamId = (await adminApi.teams.post({ name: 'Preserved pod' })).data!.id;
    await adminApi.teams({ teamId }).members.post({ email: member.email, role: 'member' });
    const person = (id: string, email: string) => ({
      id,
      email,
      enabled: true,
      emailVerified: true,
    });
    let members = [person('admin-sub', admin.email), person('member-sub', 'renamed@frnd.app')];
    const fixtureFetch = async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/token')) return Response.json({ access_token: 'fixture-token' });
      if (path.includes('/group-by-path/'))
        return Response.json({
          id: path.split('/').pop(),
          path: path.replace('/admin/realms/test/group-by-path', ''),
        });
      if (path.endsWith('/groups/admin/members')) return Response.json([]);
      if (path.endsWith('/groups/member/members')) return Response.json(members);
      throw new Error('Unexpected fixture request');
    };
    const mock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(fixtureFetch, { preconnect: globalThis.fetch.preconnect }),
    );
    try {
      await syncKeycloakAccess();
      expect(await organizationAccess(admin.userId)).toEqual({ enabled: true, admin: false });
      const renamed = await db.query.user.findFirst({ where: eq(user.id, member.userId) });
      expect(renamed).toMatchObject({
        id: member.userId,
        email: 'renamed@frnd.app',
        scimExternalId: 'member-sub',
      });
      members = [person('admin-sub', admin.email)];
      await syncKeycloakAccess();
      expect(await organizationAccess(member.userId)).toEqual({ enabled: false, admin: false });
      expect(
        await db
          .select()
          .from(teamMember)
          .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, member.userId))),
      ).toHaveLength(1);
    } finally {
      mock.mockRestore();
    }
  });
  it('uses pinned groups for sync and access changes when path lookup is unavailable', async () => {
    const { admin, member, adminApi, memberApi } = await actors();
    for (const [person, sub] of [
      [admin, 'admin-sub'],
      [member, 'member-sub'],
    ] as const)
      await db
        .update(user)
        .set({ scimExternalId: sub, emailVerified: true })
        .where(eq(user.id, person.userId));
    await setSetting('organization.subjects', ['admin-sub', 'member-sub']);
    const teamId = (await adminApi.teams.post({ name: 'Preserved team' })).data!.id;
    await adminApi.teams({ teamId }).members.post({ email: member.email, role: 'member' });
    process.env.ITSAPLAN_KEYCLOAK_ADMIN_GROUP_ID = 'admin-id';
    process.env.ITSAPLAN_KEYCLOAK_MEMBER_GROUP_ID = 'member-id';
    const person = (id: string, email: string) => ({
      id,
      email,
      enabled: true,
      emailVerified: true,
    });
    const target = person('member-sub', member.email);
    const members = new Map([
      ['admin-id', [person('admin-sub', admin.email)]],
      ['member-id', [target]],
    ]);
    const calls: string[] = [];
    let invalidGroup: 'path' | 'id' | 'missing' | null = null;
    const fixtureFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/admin/realms/test', '');
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (path.endsWith('/token')) return Response.json({ access_token: 'fixture-token' });
      if (path.startsWith('/group-by-path')) return new Response(null, { status: 404 });
      if (path === '/users') return Response.json([target]);
      for (const rank of ['admin', 'member'] as const) {
        const id = `${rank}-id`;
        if (path === `/groups/${id}`) {
          if (rank === 'member' && invalidGroup === 'missing')
            return new Response(null, { status: 404 });
          return Response.json({
            id: rank === 'member' && invalidGroup === 'id' ? 'wrong-id' : id,
            path:
              rank === 'member' && invalidGroup === 'path'
                ? organizationGroups.admin
                : organizationGroups[rank],
          });
        }
        if (path === `/groups/${id}/members`) return Response.json(members.get(id));
        if (path === `/users/member-sub/groups/${id}`) {
          members.set(
            id,
            members.get(id)!.filter((entry) => entry.id !== target.id),
          );
          if (method === 'PUT') members.get(id)!.push(target);
          return new Response(null, { status: 204 });
        }
      }
      throw new Error(`Unexpected fixture request: ${method} ${path}`);
    };
    const mock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(fixtureFetch, { preconnect: globalThis.fetch.preconnect }),
    );
    try {
      const key = await keyFor(member.userId);
      await syncKeycloakAccess();
      expect((await memberApi.teams.get()).data).toContainEqual(
        expect.objectContaining({ id: teamId }),
      );
      expect((await rpc(key, 'tools/list')).status).toBe(200);
      for (const failure of ['path', 'id', 'missing'] as const) {
        invalidGroup = failure;
        await expect(syncKeycloakAccess()).rejects.toThrow();
        await expect(setApplicationAccess(member.email, 'admin', admin.userId)).rejects.toThrow();
        expect(await organizationAccess(member.userId)).toEqual({ enabled: true, admin: false });
        expect(await organizationAccess(admin.userId)).toEqual({ enabled: true, admin: true });
        expect(calls.some((call) => call.startsWith('PUT ') || call.startsWith('DELETE '))).toBe(
          false,
        );
      }
      invalidGroup = null;
      delete process.env.ITSAPLAN_KEYCLOAK_MEMBER_GROUP_ID;
      await expect(syncKeycloakAccess()).rejects.toThrow('Configure both');
      process.env.ITSAPLAN_KEYCLOAK_MEMBER_GROUP_ID = 'member-id';
      await setApplicationAccess(member.email, 'admin', admin.userId);
      expect(await organizationAccess(member.userId)).toEqual({ enabled: true, admin: true });
      members.set('admin-id', [target]);
      await expect(setApplicationAccess(member.email, 'none', admin.userId)).rejects.toMatchObject({
        status: 409,
      });
      members.set('admin-id', [person('admin-sub', admin.email), target]);
      await setApplicationAccess(member.email, 'none', admin.userId);
      expect((await memberApi.teams.get()).status).toBe(401);
      expect((await rpc(key, 'tools/list')).status).toBe(401);
      await setApplicationAccess(member.email, 'member', admin.userId);
      expect((await memberApi.teams.get()).data).toContainEqual(
        expect.objectContaining({ id: teamId }),
      );
      expect((await rpc(key, 'tools/list')).status).toBe(200);
      expect(calls.some((call) => call.includes('/group-by-path'))).toBe(false);
    } finally {
      mock.mockRestore();
    }
  });
});
