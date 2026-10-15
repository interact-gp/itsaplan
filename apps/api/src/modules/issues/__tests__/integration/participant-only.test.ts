import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  db,
  issue,
  issueParticipant,
  issueWatcher,
  issueAttachment,
  agentRun,
  organizationGroups,
  project,
  scimGroup,
  scimGroupMember,
  setSetting,
} from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { api, authedApi, type Api } from '#tests/helpers/app';
import { createAgent } from '#tests/helpers/agents';
import { signUpTestUser, type TestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

// In a participant-only project an issue is visible only to its creator, its current
// assignee and the participants added to it. Other members, the project owner and an
// organization admin get a 404 for it and do not find it in any list.

async function join(asOwner: Api, projectKey: string, person: TestUser) {
  const invite = await asOwner
    .projects({ projectKey })
    .invites.post({ email: person.email, role: 'member' });
  await authedApi(person.cookie).invites({ token: invite.data!.token }).accept.post();
}

async function grant(person: TestUser, rank: 'admin' | 'member') {
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

describe('participant-only issues', () => {
  const managed = process.env.ITSAPLAN_MANAGED_ACCESS;
  beforeEach(resetDb);
  afterEach(() => {
    process.env.ITSAPLAN_MANAGED_ACCESS = managed;
  });

  async function world() {
    await signUpTestUser();
    const owner = await signUpTestUser({ name: 'Owner' });
    const asOwner = authedApi(owner.cookie);
    await asOwner.projects.post({ key: 'REQ', name: 'General Requests' });
    await asOwner.projects.post({ key: 'MKT', name: 'Marketing' });
    const people: Record<string, TestUser> = {};
    for (const name of ['asker', 'helper', 'added', 'other']) {
      people[name] = await signUpTestUser({ name });
      await join(asOwner, 'REQ', people[name]!);
      await asOwner
        .projects({ projectKey: 'MKT' })
        .members.post({ userId: people[name]!.userId, role: 'member' });
    }
    const admin = await signUpTestUser({ name: 'Admin' });
    // Can use the app but is not in the request project.
    const stranger = await signUpTestUser({ name: 'Stranger' });
    await db.update(project).set({ participantOnly: true }).where(eq(project.key, 'REQ'));
    process.env.ITSAPLAN_MANAGED_ACCESS = 'true';
    for (const person of [owner, stranger, ...Object.values(people)]) await grant(person, 'member');
    await grant(admin, 'admin');
    await setSetting('organization.lastSync', Date.now());

    const { asker, helper, added, other } = people as Record<string, TestUser>;
    const req = (await asOwner.projects({ projectKey: 'REQ' }).get()).data!;
    const columnId = req.columns[0]!.id;
    const created = await authedApi(asker!.cookie).projects({ projectKey: 'REQ' }).issues.post({
      columnId,
      title: 'Review my PR',
      description: 'secret plan',
      assigneeUserId: helper!.userId,
    });
    const request = created.data!;
    await db.insert(issueParticipant).values({ issueId: request.id, userId: added!.userId });
    return {
      owner: owner,
      asker: asker!,
      helper: helper!,
      added: added!,
      other: other!,
      admin,
      stranger,
      request,
      columnId,
    };
  }

  const titles = (rows: { title: string }[] | undefined | null) => (rows ?? []).map((r) => r.title);

  it('shows the request to its creator, assignee and added participant', async () => {
    const { asker, helper, added, request } = await world();
    for (const person of [asker, helper, added]) {
      const as = authedApi(person.cookie);
      const rev = await as.sync.rev.get({ query: { scopes: `issue:${request.id}` } });
      expect(rev.data!.revs[`issue:${request.id}`]).not.toBe('0');
      expect((await as.issues({ issueId: request.id }).get()).status).toBe(200);
      const byNumber = await as
        .projects({ projectKey: 'REQ' })
        .issues({ sequenceNumber: request.sequenceNumber })
        .get();
      expect(byNumber.status).toBe(200);
      const board = await as.projects({ projectKey: 'REQ' }).issues.board.get();
      expect(titles(board.data?.issues)).toEqual(['Review my PR']);
      const search = await as.projects({ projectKey: 'REQ' }).issues.search.get({
        query: { q: 'secret' },
      });
      expect(titles(search.data)).toEqual(['Review my PR']);
      const list = await as.projects({ projectKey: 'REQ' }).issues.get({ query: {} });
      expect(titles(list.data)).toEqual(['Review my PR']);
    }
  });

  it('hides the request from another member, the project owner and an organization admin', async () => {
    const { owner, other, admin, request } = await world();
    for (const person of [other, owner, admin]) {
      const as = authedApi(person.cookie);
      const one = as.issues({ issueId: request.id });
      expect((await one.get()).status).toBe(404);
      expect(
        (
          await as
            .projects({ projectKey: 'REQ' })
            .issues({ sequenceNumber: request.sequenceNumber })
            .get()
        ).status,
      ).toBe(404);
      expect((await one.feed.get()).status).toBe(404);
      expect((await one.checklists.get()).status).toBe(404);
      expect((await one.worklogs.get()).status).toBe(404);
      expect((await one.attachments.get()).status).toBe(404);
      expect((await one.comments.post({ body: 'hello' })).status).toBe(404);
      expect((await one.patch({ title: 'Taken over' })).status).toBe(404);

      const reqProject = as.projects({ projectKey: 'REQ' }).issues;
      expect((await reqProject.board.get()).data?.issues).toEqual([]);
      expect((await reqProject.get({ query: {} })).data).toEqual([]);
      expect((await reqProject.search.get({ query: { q: 'secret' } })).data).toEqual([]);
      expect((await reqProject.archived.get()).data).toEqual([]);

      const rev = await as.sync.rev.get({ query: { scopes: `issue:${request.id}` } });
      // A hidden issue reads like one that does not exist.
      expect(rev.data!.revs[`issue:${request.id}`]).toBe('0');
    }
  });

  it('does not let a hidden request be changed or deleted in bulk', async () => {
    const { owner, admin, request } = await world();
    for (const person of [owner, admin]) {
      const bulk = authedApi(person.cookie).projects({ projectKey: 'REQ' }).issues.bulk;
      const updated = await bulk.patch({ ids: [request.id], patch: { dueDate: '2030-01-01' } });
      expect(updated.data).toMatchObject({ updated: 0 });
    }
    const [row] = await db.select().from(issue).where(eq(issue.id, request.id));
    expect(row!.dueDate).toBeNull();
  });

  it('cannot be shared publicly, and an old public link shows nothing', async () => {
    const { asker, request } = await world();
    const share = await authedApi(asker.cookie).issues({ issueId: request.id }).share.post({});
    expect(share.status).toBe(400);
    await db.update(issue).set({ shareToken: crypto.randomUUID() }).where(eq(issue.id, request.id));
    const [row] = await db.select().from(issue).where(eq(issue.id, request.id));
    expect((await api.share.issue({ token: row!.shareToken! }).get()).status).toBe(404);
  });

  it('leaves ordinary projects as they are', async () => {
    const { other, admin, columnId } = await world();
    const asOther = authedApi(other.cookie);
    const mkt = (await asOther.projects({ projectKey: 'MKT' }).get()).data!;
    const created = await asOther
      .projects({ projectKey: 'MKT' })
      .issues.post({ columnId: mkt.columns[0]!.id, title: 'Open task' });
    expect(created.status).toBe(201);
    expect(columnId).toBeGreaterThan(0);
    const seen = await authedApi(admin.cookie).issues({ issueId: created.data!.id }).get();
    expect(seen.status).toBe(200);
  });

  describe('who is in a request', () => {
    const sees = async (person: TestUser, issueId: number) =>
      (await authedApi(person.cookie).issues({ issueId }).get()).status;
    const participants = (person: TestUser, issueId: number) =>
      authedApi(person.cookie).issues({ issueId }).participants;

    it('lets the requester add and remove people, and removal ends access at once', async () => {
      const { asker, other, request } = await world();
      const added = await participants(asker, request.id)({ userId: other.userId }).put();
      expect(added.status).toBe(200);
      expect(added.data!.map((p) => p.userId)).toContain(other.userId);
      expect(await sees(other, request.id)).toBe(200);

      const removed = await participants(asker, request.id)({ userId: other.userId }).delete();
      expect(removed.status).toBe(200);
      expect(await sees(other, request.id)).toBe(404);
      const watching = await db
        .select()
        .from(issueWatcher)
        .where(and(eq(issueWatcher.issueId, request.id), eq(issueWatcher.userId, other.userId)));
      expect(watching).toHaveLength(0);
    });

    it('does not let an added participant, or anyone outside, change who is in it', async () => {
      const { added, other, owner, admin, request } = await world();
      expect((await participants(added, request.id)({ userId: other.userId }).put()).status).toBe(
        403,
      );
      for (const outsider of [other, owner, admin])
        expect(
          (await participants(outsider, request.id)({ userId: outsider.userId }).put()).status,
        ).toBe(404);
      expect(await sees(other, request.id)).toBe(404);
    });

    it('only adds enabled members of the project', async () => {
      const { asker, stranger, request } = await world();
      expect(
        (await participants(asker, request.id)({ userId: stranger.userId }).put()).status,
      ).toBe(400);
    });

    it('moves access with a reassignment, which only the requester or assignee may do', async () => {
      const { asker, helper, added, other, request } = await world();
      const byParticipant = await authedApi(added.cookie)
        .issues({ issueId: request.id })
        .patch({ assigneeUserId: other.userId });
      expect(byParticipant.status).toBe(403);

      const reassigned = await authedApi(asker.cookie)
        .issues({ issueId: request.id })
        .patch({ assigneeUserId: other.userId });
      expect(reassigned.status).toBe(200);
      expect(await sees(other, request.id)).toBe(200);
      expect(await sees(helper, request.id)).toBe(404);
      expect(await sees(asker, request.id)).toBe(200);
    });

    it('refuses a bulk reassignment as a whole when it holds a request the actor may not reassign', async () => {
      const { asker, added, other, columnId } = await world();
      const create = (person: TestUser, assigneeUserId: string) =>
        authedApi(person.cookie)
          .projects({ projectKey: 'REQ' })
          .issues.post({ columnId, title: 'Bulk', assigneeUserId });
      const own = (await create(added, added.userId)).data!;
      const joined = (await create(asker, asker.userId)).data!;
      await db.insert(issueParticipant).values({ issueId: joined.id, userId: added.userId });

      const bulk = await authedApi(added.cookie)
        .projects({ projectKey: 'REQ' })
        .issues.bulk.patch({ ids: [own.id, joined.id], patch: { assigneeUserId: other.userId } });
      expect(bulk.status).toBe(403);
      const rows = await db.select().from(issue).where(eq(issue.title, 'Bulk'));
      expect(rows.map((r) => r.assigneeUserId).sort()).toEqual([added.userId, asker.userId].sort());
    });

    it('does not reach or subscribe someone mentioned who is not in the request', async () => {
      const { asker, other, request } = await world();
      const handle = other.username;
      await authedApi(asker.cookie)
        .issues({ issueId: request.id })
        .comments.post({ body: `@${handle} can you look?` });
      const inbox = await authedApi(other.cookie).notifications.get({ query: {} });
      expect(JSON.stringify(inbox.data)).not.toContain('Review my PR');
      const watching = await db
        .select()
        .from(issueWatcher)
        .where(and(eq(issueWatcher.issueId, request.id), eq(issueWatcher.userId, other.userId)));
      expect(watching).toHaveLength(0);
    });

    it('does not apply a column auto-assignee to a request', async () => {
      const { owner, asker, other, columnId } = await world();
      await authedApi(owner.cookie)
        .projects({ projectKey: 'REQ' })
        .columns({ columnId })
        .patch({ autoAssignUserId: other.userId });
      const created = await authedApi(asker.cookie)
        .projects({ projectKey: 'REQ' })
        .issues.post({ columnId, title: 'Unassigned request' });
      expect(created.data!.assigneeUserId).toBeNull();
      expect(await sees(other, created.data!.id)).toBe(404);
    });

    it('keeps participants to private request projects', async () => {
      const { other } = await world();
      const asOther = authedApi(other.cookie);
      const mkt = (await asOther.projects({ projectKey: 'MKT' }).get()).data!;
      const task = await asOther
        .projects({ projectKey: 'MKT' })
        .issues.post({ columnId: mkt.columns[0]!.id, title: 'Open task' });
      expect((await participants(other, task.data!.id).get()).data).toEqual([]);
      const add = await participants(other, task.data!.id)({ userId: other.userId }).put();
      expect(add.status).toBe(400);
    });
  });

  describe('project-wide paths found in review', () => {
    it('closes Docs, so request titles cannot be read through document links', async () => {
      const { owner, admin } = await world();
      for (const person of [owner, admin]) {
        const docs = authedApi(person.cookie).projects({ projectKey: 'REQ' }).documents;
        expect((await docs.post({ title: 'Probe' })).status).toBe(403);
        expect((await docs.get({ query: {} })).status).toBe(403);
      }
    });

    it('does not let a column be deleted together with the requests in it', async () => {
      const { owner, columnId, request } = await world();
      const removed = await authedApi(owner.cookie)
        .projects({ projectKey: 'REQ' })
        .columns({ columnId })
        .delete({ mode: 'delete' });
      expect(removed.status).toBe(400);
      const [row] = await db.select().from(issue).where(eq(issue.id, request.id));
      expect(row).toBeDefined();
    });

    it('does not hand a request to an agent mentioned in it', async () => {
      const { owner, asker, request } = await world();
      const agent = await createAgent(authedApi(owner.cookie), 'REQ', {
        name: 'Helper',
        username: 'helper-bot',
        kind: 'internal',
      });
      expect(agent.status).toBeLessThan(300);
      await authedApi(asker.cookie)
        .issues({ issueId: request.id })
        .comments.post({ body: '@helper-bot summarise this' });
      expect(await db.select().from(agentRun)).toEqual([]);
    });

    it('shows no request counts on the team page', async () => {
      const { asker } = await world();
      const asAsker = authedApi(asker.cookie);
      const req = (await asAsker.projects({ projectKey: 'REQ' }).get()).data!.project;
      const detail = await asAsker
        .teams({ teamId: req.teamId })
        .projects({ projectId: req.id })
        .get();
      expect(detail.status).toBe(200);
      expect(detail.data!.stats).toMatchObject({ open: 0, unassigned: 0 });
      expect(detail.data!.lastActivityAt).toBeNull();
    });
  });

  describe('files of a request', () => {
    // Created as a row: these checks run before any stored bytes are read.
    async function attach(issueId: number) {
      const [row] = await db
        .insert(issueAttachment)
        .values({
          issueId,
          s3Key: `test/${issueId}`,
          filename: 'salary-sheet.pdf',
          contentType: 'application/pdf',
          sizeBytes: 10,
        })
        .returning();
      return row!;
    }

    it('gives request files a signed-in link and closes the public one', async () => {
      const { asker, request } = await world();
      const file = await attach(request.id);
      const listed = await authedApi(asker.cookie)
        .issues({ issueId: request.id })
        .attachments.get();
      expect(listed.data![0]!.url).toBe(`/issues/${request.id}/attachments/${file.publicId}/raw`);
      const open = await api.attachments({ publicId: file.publicId }).raw.get({ query: {} });
      // Refused by the visibility check, not by missing storage in this environment.
      expect(open.status).toBe(404);
      expect(JSON.stringify(open.error?.value)).toContain('Attachment not found');
    });

    it('stops a kept link from working once someone is removed', async () => {
      const { asker, other, request } = await world();
      const file = await attach(request.id);
      const people = authedApi(asker.cookie).issues({ issueId: request.id }).participants;
      await people({ userId: other.userId }).put();
      const kept = () =>
        authedApi(other.cookie)
          .issues({ issueId: request.id })
          .attachments({ publicId: file.publicId })
          .raw.get({ query: {} });
      // Without object storage in this environment an allowed read still fails on the
      // missing bytes; what matters is that the access check let it through.
      const blocked = async () =>
        JSON.stringify((await kept()).error?.value).includes('Issue not found');
      expect(await blocked()).toBe(false);
      await people({ userId: other.userId }).delete();
      expect(await blocked()).toBe(true);
    });

    it('keeps the public link for files of ordinary projects', async () => {
      const { other } = await world();
      const asOther = authedApi(other.cookie);
      const mkt = (await asOther.projects({ projectKey: 'MKT' }).get()).data!;
      const task = await asOther
        .projects({ projectKey: 'MKT' })
        .issues.post({ columnId: mkt.columns[0]!.id, title: 'Open task' });
      const file = await attach(task.data!.id);
      const listed = await asOther.issues({ issueId: task.data!.id }).attachments.get();
      expect(listed.data![0]!.url).toBe(`/attachments/${file.publicId}/raw`);
    });
  });
});
