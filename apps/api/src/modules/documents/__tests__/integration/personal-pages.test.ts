import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  db,
  organizationGroups,
  projectDocument,
  scimGroup,
  scimGroupMember,
  setSetting,
} from '@repo/db';
import { auth } from '@repo/auth';
import { app, authedApi } from '#tests/helpers/app';
import { signUpTestUser, type TestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

// A member's "My To-do" page is reachable only by its owner: other members, the
// project owner, organization admins and the instance owner get no access through the
// web API or MCP, and the owner cannot make it public, hand it over or copy it.

type Client = ReturnType<typeof authedApi>;

async function grant(person: TestUser, rank: 'admin' | 'member') {
  const [group] = await db
    .insert(scimGroup)
    .values({ displayName: organizationGroups[rank] })
    .onConflictDoUpdate({
      target: scimGroup.displayName,
      set: { displayName: organizationGroups[rank] },
    })
    .returning();
  await db
    .insert(scimGroupMember)
    .values({ groupId: group!.id, userId: person.userId })
    .onConflictDoNothing();
}

async function join(owner: Client, person: TestUser) {
  const invite = await owner
    .projects({ projectKey: 'NOTES' })
    .invites.post({ email: person.email, role: 'member' });
  await authedApi(person.cookie).invites({ token: invite.data!.token }).accept.post();
}

async function mcp(person: TestUser, name: string, args: Record<string, unknown>) {
  const { key } = await auth.api.createApiKey({ body: { name: 'test', userId: person.userId } });
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
        params: { name, arguments: args },
      }),
    }),
  );
  const body = await response.text();
  return JSON.parse(body.slice(body.indexOf('data: ') + 6)).result as {
    isError?: boolean;
    content: { text: string }[];
  };
}

describe('personal pages', () => {
  const managed = process.env.ITSAPLAN_MANAGED_ACCESS;
  beforeEach(resetDb);
  afterEach(() => {
    process.env.ITSAPLAN_MANAGED_ACCESS = managed;
  });

  async function world() {
    const god = await signUpTestUser();
    const owner = await signUpTestUser({ name: 'Project owner' });
    const asOwner = authedApi(owner.cookie);
    await asOwner.projects.post({ key: 'NOTES', name: 'Personal Notes' });
    const project = (await asOwner.projects({ projectKey: 'NOTES' }).get()).data!.project;
    const member = await signUpTestUser({ name: 'Member' });
    const other = await signUpTestUser({ name: 'Other member' });
    const admin = await signUpTestUser({ name: 'Organization admin' });
    await join(asOwner, member);
    await join(asOwner, other);
    // No route creates a personal page, and provisioning puts it in a project whose
    // owner nobody can sign in as; this project has a human owner to test against.
    const [page] = await db
      .insert(projectDocument)
      .values({
        projectId: project.id,
        title: 'My To-do',
        content: '- [ ] Send the quarterly report',
        isPrivate: true,
        personal: true,
        ownerUserId: member.userId,
      })
      .returning();
    process.env.ITSAPLAN_MANAGED_ACCESS = 'true';
    for (const person of [owner, member, other]) await grant(person, 'member');
    await grant(admin, 'admin');
    await setSetting('organization.lastSync', Date.now());
    return { god, owner, asOwner, member, other, admin, project, page: page! };
  }

  function page(api: Client, documentId: number) {
    return api.projects({ projectKey: 'NOTES' }).documents({ documentId });
  }

  it('lets the owner read, search, edit, export and see revisions of their page', async () => {
    const { member, page: todo } = await world();
    const asMember = authedApi(member.cookie);
    expect((await page(asMember, todo.id).get()).status).toBe(200);
    const found = await asMember
      .projects({ projectKey: 'NOTES' })
      .documents.get({ query: { q: 'quarterly' } });
    expect(found.data?.map((d) => d.id)).toEqual([todo.id]);
    expect(found.data?.[0]?.personal).toBe(true);
    const edited = await page(asMember, todo.id).patch({
      version: todo.version,
      content: '- [x] Send the quarterly report',
    });
    expect(edited.status).toBe(200);
    expect((await page(asMember, todo.id).export.get()).status).toBe(200);
    expect((await page(asMember, todo.id).revisions.get()).data?.length).toBeGreaterThan(0);
  });

  it('hides the page from the organization admin, the project owner and other members', async () => {
    const { asOwner, other, admin, page: todo } = await world();
    for (const api of [asOwner, authedApi(other.cookie), authedApi(admin.cookie)]) {
      expect((await page(api, todo.id).get()).status).toBe(404);
      expect((await page(api, todo.id).export.get()).status).toBe(404);
      expect((await page(api, todo.id).revisions.get()).status).toBe(404);
      expect((await page(api, todo.id).assets.get()).status).toBe(404);
      const edit = await page(api, todo.id).patch({ version: todo.version, title: 'Read' });
      expect(edit.status).toBe(404);
      const listed = await api
        .projects({ projectKey: 'NOTES' })
        .documents.get({ query: { q: 'quarterly' } });
      expect(listed.data).toEqual([]);
    }
  });

  it('keeps the admin override for ordinary private pages', async () => {
    const { other, admin } = await world();
    const created = await authedApi(other.cookie)
      .projects({ projectKey: 'NOTES' })
      .documents.post({ title: 'Draft', isPrivate: true });
    expect((await page(authedApi(admin.cookie), created.data!.id).get()).status).toBe(200);
  });

  it('gives the instance owner no access', async () => {
    const { god, page: todo } = await world();
    expect((await page(authedApi(god.cookie), todo.id).get()).status).not.toBe(200);
  });

  it('hides the page from an organization admin over MCP', async () => {
    const { admin, member, page: todo } = await world();
    const asAdmin = await mcp(admin, 'get_document', {
      projectKey: 'NOTES',
      documentId: todo.id,
    });
    expect(asAdmin.isError).toBe(true);
    expect(JSON.stringify(asAdmin)).not.toContain('quarterly');
    const asOwner = await mcp(member, 'get_document', {
      projectKey: 'NOTES',
      documentId: todo.id,
    });
    expect(asOwner.isError).toBeFalsy();
  });

  it('does not let the owner make the page public, hand it over, copy, archive, lock or nest it', async () => {
    const { other, member, page: todo } = await world();
    const asMember = authedApi(member.cookie);
    const version = todo.version;
    expect((await page(asMember, todo.id).access.post({ version, isPrivate: false })).status).toBe(
      400,
    );
    expect(
      (await page(asMember, todo.id).ownership.post({ version, ownerUserId: other.userId })).status,
    ).toBe(400);
    expect((await page(asMember, todo.id).duplicate.post({ version })).status).toBe(400);
    expect((await page(asMember, todo.id).archive.post({ version })).status).toBe(400);
    expect((await page(asMember, todo.id).lock.post({ version })).status).toBe(400);

    const notes = asMember.projects({ projectKey: 'NOTES' }).documents;
    const shared = await notes.post({ title: 'Shared page' });
    expect((await notes.post({ title: 'Child', parentId: todo.id })).status).toBe(400);
    expect(
      (await page(asMember, todo.id).patch({ version, parentId: shared.data!.id })).status,
    ).toBe(400);
  });

  it('allows one personal page per member', async () => {
    const { member, project } = await world();
    const second = db
      .insert(projectDocument)
      .values({
        projectId: project.id,
        title: 'Another',
        isPrivate: true,
        personal: true,
        ownerUserId: member.userId,
      })
      .execute();
    await expect(second).rejects.toThrow();
  });

  it('leaves the page out when the owner copies the project', async () => {
    const { member, page: todo } = await world();
    await grant(member, 'admin');
    const copy = await authedApi(member.cookie)
      .projects({ projectKey: 'NOTES' })
      .copy.post({ key: 'COPY', name: 'Copy', include: { documents: true } });
    expect(copy.status).toBeLessThan(300);
    const copied = await authedApi(member.cookie)
      .projects({ projectKey: 'COPY' })
      .documents.get({ query: {} });
    expect(copied.data?.map((d) => d.title)).not.toContain(todo.title);
  });
});
