import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  db,
  organizationGroups,
  project,
  projectDocument,
  scimGroup,
  scimGroupMember,
  setSetting,
  user,
} from '@repo/db';
import { eq } from 'drizzle-orm';
import { auth } from '@repo/auth';
import { app, authedApi } from '#tests/helpers/app';
import { createAgent } from '#tests/helpers/agents';
import { signUpTestUser, type TestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { provisionPersonalPages } from '../../service';
import { personalWorkspace } from '../../workspace';

// Every member who may use the app gets exactly one "My To-do" page in the shared
// Personal Notes project, however often or concurrently provisioning runs.

async function myPage(person: TestUser) {
  return authedApi(person.cookie).account['personal-page'].get();
}

function pageOf(person: TestUser, projectKey: string, documentId: number) {
  return authedApi(person.cookie).projects({ projectKey }).documents({ documentId });
}

async function grantAccess(person: TestUser) {
  const [group] = await db
    .insert(scimGroup)
    .values({ displayName: organizationGroups.member })
    .onConflictDoUpdate({
      target: scimGroup.displayName,
      set: { displayName: organizationGroups.member },
    })
    .returning();
  await db.insert(scimGroupMember).values({ groupId: group!.id, userId: person.userId });
  await setSetting('organization.lastSync', Date.now());
}

describe('personal page provisioning', () => {
  const managed = process.env.ITSAPLAN_MANAGED_ACCESS;
  beforeEach(resetDb);
  afterEach(() => {
    process.env.ITSAPLAN_MANAGED_ACCESS = managed;
  });

  it('gives each member one page, however often and concurrently it runs', async () => {
    await signUpTestUser();
    const priya = await signUpTestUser({ name: 'Priya' });
    const rahul = await signUpTestUser({ name: 'Rahul' });
    expect((await myPage(priya)).status).toBe(404);

    await Promise.all([provisionPersonalPages(), provisionPersonalPages()]);
    await provisionPersonalPages();

    const page = (await myPage(priya)).data!;
    expect(page.projectKey).toBe('MYTODO');
    const docs = await authedApi(priya.cookie)
      .projects({ projectKey: 'MYTODO' })
      .documents.get({ query: {} });
    expect(docs.data).toHaveLength(1);
    expect(docs.data![0]).toMatchObject({ id: page.documentId, title: 'My To-do', personal: true });
    expect((await myPage(rahul)).data!.documentId).not.toBe(page.documentId);
  });

  it('lets the owner keep a checklist in the page', async () => {
    await signUpTestUser();
    const priya = await signUpTestUser({ name: 'Priya' });
    await provisionPersonalPages();
    const { projectKey, documentId } = (await myPage(priya)).data!;
    const current = (await pageOf(priya, projectKey, documentId).get()).data!;
    const contentJson = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Send report' }] }],
            },
          ],
        },
      ],
    };
    const saved = await pageOf(priya, projectKey, documentId).patch({
      version: current.version,
      content: '- [ ] Send report',
      contentJson,
    });
    expect(saved.status).toBe(200);
    expect(saved.data!.contentJson).toEqual(contentJson);
  });

  it('does not let members create pages in the shared project or see each other', async () => {
    await signUpTestUser();
    const priya = await signUpTestUser({ name: 'Priya' });
    const rahul = await signUpTestUser({ name: 'Rahul' });
    await provisionPersonalPages();
    const notes = authedApi(priya.cookie).projects({ projectKey: 'MYTODO' }).documents;
    expect((await notes.post({ title: 'Shared' })).status).toBe(403);
    const rahulPage = (await myPage(rahul)).data!;
    expect((await pageOf(priya, 'MYTODO', rahulPage.documentId).get()).status).toBe(404);
  });

  it('skips AI agents and deactivated accounts, and gives a returning member their page back', async () => {
    await signUpTestUser();
    const owner = await signUpTestUser({ name: 'Owner' });
    const asOwner = authedApi(owner.cookie);
    await asOwner.projects.post({ key: 'MKT', name: 'Marketing' });
    const agent = await createAgent(asOwner, 'MKT', {
      name: 'Helper',
      username: 'helper',
      kind: 'internal',
    });
    const priya = await signUpTestUser({ name: 'Priya' });
    await provisionPersonalPages();
    const first = (await myPage(priya)).data!;

    const agentPages = await db
      .select()
      .from(projectDocument)
      .where(eq(projectDocument.ownerUserId, agent.data!.agent.userId));
    expect(agentPages).toHaveLength(0);

    await db.update(user).set({ active: false }).where(eq(user.id, priya.userId));
    await provisionPersonalPages();
    await db.update(user).set({ active: true }).where(eq(user.id, priya.userId));
    await provisionPersonalPages();
    expect((await myPage(priya)).data!.documentId).toBe(first.documentId);
  });

  it('adds back a member who left the shared project, keeping their page', async () => {
    await signUpTestUser();
    const priya = await signUpTestUser({ name: 'Priya' });
    await provisionPersonalPages();
    const { documentId } = (await myPage(priya)).data!;
    const left = await authedApi(priya.cookie)
      .projects({ projectKey: 'MYTODO' })
      .members({ userId: priya.userId })
      .delete();
    expect(left.status).toBeLessThan(300);
    expect((await pageOf(priya, 'MYTODO', documentId).get()).status).not.toBe(200);
    await provisionPersonalPages();
    expect((await pageOf(priya, 'MYTODO', documentId).get()).status).toBe(200);
  });

  it('provisions only members with application access when access is managed', async () => {
    await signUpTestUser();
    const priya = await signUpTestUser({ name: 'Priya' });
    const rahul = await signUpTestUser({ name: 'Rahul' });
    process.env.ITSAPLAN_MANAGED_ACCESS = 'true';
    await grantAccess(priya);
    await provisionPersonalPages();
    expect((await myPage(priya)).status).toBe(200);
    await grantAccess(rahul);
    expect((await myPage(rahul)).status).toBe(404);
    await provisionPersonalPages();
    expect((await myPage(rahul)).status).toBe(200);
  });

  it('waits for the first person, who still becomes the instance owner', async () => {
    await provisionPersonalPages();
    const owner = await signUpTestUser({ name: 'Owner' });
    expect((await authedApi(owner.cookie).god['auth-settings'].get()).status).toBe(200);
    await provisionPersonalPages();
    expect((await myPage(owner)).status).toBe(200);
  });

  it('refuses to delete the Personal Notes project and recreates a missing one', async () => {
    await signUpTestUser();
    const priya = await signUpTestUser({ name: 'Priya' });
    await provisionPersonalPages();
    const admin = await signUpTestUser({ name: 'Admin' });
    process.env.ITSAPLAN_MANAGED_ACCESS = 'true';
    for (const [person, rank] of [
      [priya, 'member'],
      [admin, 'admin'],
    ] as const) {
      const [group] = await db
        .insert(scimGroup)
        .values({ displayName: organizationGroups[rank] })
        .onConflictDoUpdate({
          target: scimGroup.displayName,
          set: { displayName: organizationGroups[rank] },
        })
        .returning();
      await db.insert(scimGroupMember).values({ groupId: group!.id, userId: person.userId });
    }
    await setSetting('organization.lastSync', Date.now());
    const deleted = await authedApi(admin.cookie).projects({ projectKey: 'MYTODO' }).delete();
    expect(deleted.status).toBe(409);
    expect((await myPage(priya)).status).toBe(200);

    const { projectId } = await personalWorkspace();
    await db.delete(project).where(eq(project.id, projectId!));
    await provisionPersonalPages();
    const again = (await myPage(priya)).data!;
    expect((await pageOf(priya, again.projectKey, again.documentId).get()).status).toBe(200);
  });

  it('uses another key when a project already has MYTODO', async () => {
    await signUpTestUser();
    const owner = await signUpTestUser({ name: 'Owner' });
    await authedApi(owner.cookie).projects.post({ key: 'MYTODO', name: 'Someone else' });
    await provisionPersonalPages();
    await provisionPersonalPages();
    expect((await myPage(owner)).data!.projectKey).toBe('MYTODO2');
  });

  it('keeps a one-team member on their team over MCP', async () => {
    await signUpTestUser();
    const priya = await signUpTestUser({ name: 'Priya' });
    await provisionPersonalPages();
    const { key } = await auth.api.createApiKey({ body: { name: 'mcp', userId: priya.userId } });
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_team_projects', arguments: {} },
        }),
      }),
    );
    const body = await response.text();
    const result = JSON.parse(body.slice(body.indexOf('data: ') + 6)).result;
    expect(result.isError).toBeFalsy();
  });
});
