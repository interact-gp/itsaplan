import { beforeEach, describe, expect, it } from 'bun:test';
import { db, user } from '@repo/db';
import { eq } from 'drizzle-orm';
import { authedApi } from '#tests/helpers/app';
import { signUpTestUser, type TestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { provisionPersonalPages } from '#modules/personal-pages/service';
import { deleteProject } from '#modules/projects/service';
import { requestDesk } from '../../desk';
import { provisionRequestDesk } from '../../service';

// FRND Requests: once an administrator turns it on, every member who may use the app
// is enrolled in General Requests, where each request stays private to the people in
// it and the project-wide sections are closed.

async function provision() {
  await provisionPersonalPages();
  await provisionRequestDesk();
}

const requests = (person: TestUser) => authedApi(person.cookie).projects({ projectKey: 'REQ' });

describe('FRND Requests', () => {
  beforeEach(resetDb);

  async function world() {
    const god = await signUpTestUser({ name: 'Instance owner' });
    const priya = await signUpTestUser({ name: 'Priya' });
    const rahul = await signUpTestUser({ name: 'Rahul' });
    const ankit = await signUpTestUser({ name: 'Ankit' });
    return { god, priya, rahul, ankit };
  }

  it('enrols nobody until an administrator turns it on', async () => {
    const { god, priya } = await world();
    await provision();
    expect((await requests(priya).get()).status).not.toBe(200);
    const asPriya = authedApi(priya.cookie);
    expect((await asPriya.god['frnd-requests'].put({ enabled: true })).status).toBe(403);

    expect((await authedApi(god.cookie).god['frnd-requests'].put({ enabled: true })).status).toBe(
      200,
    );
    await Promise.all([provision(), provision()]);
    await provision();
    const desk = await requests(priya).get();
    expect(desk.status).toBe(200);
    expect(desk.data!.project).toMatchObject({ name: 'General Requests', participantOnly: true });
    const mine = (await asPriya.projects.get()).data!.filter((p) => p.key === 'REQ');
    expect(mine).toHaveLength(1);
  });

  it('lets a member ask another member, privately', async () => {
    const { god, priya, rahul, ankit } = await world();
    await authedApi(god.cookie).god['frnd-requests'].put({ enabled: true });
    await provision();
    const columnId = (await requests(priya).get()).data!.columns[0]!.id;
    const asked = await requests(priya).issues.post({
      columnId,
      title: 'Review my PR #42',
      assigneeUserId: rahul.userId,
    });
    expect(asked.status).toBe(201);
    const seen = (person: TestUser) =>
      authedApi(person.cookie).issues({ issueId: asked.data!.id }).get();
    expect((await seen(rahul)).status).toBe(200);
    expect((await seen(ankit)).status).toBe(404);
    expect((await seen(god)).status).toBe(404);
  });

  it('keeps the project-wide sections closed, even to an administrator turning them on', async () => {
    const { god, priya } = await world();
    await authedApi(god.cookie).god['frnd-requests'].put({ enabled: true });
    await provision();
    const desk = requests(priya);
    expect((await desk.analytics.stats.get({ query: {} })).status).toBe(403);
    expect((await desk.cycles.get({ query: {} })).status).toBe(403);
    expect((await desk.webhooks.get()).status).toBe(403);
    const project = (await desk.get()).data!.project;
    expect(project).toMatchObject({
      dashboardsEnabled: false,
      cyclesEnabled: false,
      initiativesEnabled: false,
      documentsEnabled: false,
      notesEnabled: false,
      subtasksEnabled: false,
    });
  });

  it('refuses links between requests and deleting the project', async () => {
    const { god, priya, rahul } = await world();
    await authedApi(god.cookie).god['frnd-requests'].put({ enabled: true });
    await provision();
    const columnId = (await requests(priya).get()).data!.columns[0]!.id;
    const a = await requests(priya).issues.post({
      columnId,
      title: 'One',
      assigneeUserId: rahul.userId,
    });
    const b = await requests(priya).issues.post({
      columnId,
      title: 'Two',
      assigneeUserId: rahul.userId,
    });
    const link = await authedApi(priya.cookie)
      .issues({ issueId: a.data!.id })
      .links.post({ targetIssueId: b.data!.id, kind: 'relates' });
    expect(link.status).toBe(400);
    const { projectId } = await requestDesk();
    await expect(deleteProject(projectId!)).rejects.toMatchObject({ status: 409 });
  });

  it('enrols a returning member again and leaves out deactivated accounts', async () => {
    const { god, priya, rahul } = await world();
    await db.update(user).set({ active: false }).where(eq(user.id, rahul.userId));
    await authedApi(god.cookie).god['frnd-requests'].put({ enabled: true });
    await provision();
    const asPriya = authedApi(priya.cookie);
    const left = await asPriya
      .projects({ projectKey: 'REQ' })
      .members({ userId: priya.userId })
      .delete();
    expect(left.status).toBeLessThan(300);
    await provision();
    expect((await requests(priya).get()).status).toBe(200);
    const members = (await authedApi(god.cookie).god['frnd-requests'].get()).data!;
    expect(members.enabled).toBe(true);
    await db.update(user).set({ active: true }).where(eq(user.id, rahul.userId));
    await provision();
    expect((await requests(rahul).get()).status).toBe(200);
  });

  it('does not offer the system account as someone to assign or add', async () => {
    const { god, priya } = await world();
    await authedApi(god.cookie).god['frnd-requests'].put({ enabled: true });
    await provision();
    const names = (await requests(priya).get()).data!.assignees.map((a) => a.name);
    expect(names).toContain('Priya');
    expect(names).not.toContain('Itsaplan system');
  });
});
