import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { db, slackRequestMessage, user } from '@repo/db';
import { eq } from 'drizzle-orm';
import { authedApi } from '#tests/helpers/app';
import { signUpTestUser, type TestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { provisionPersonalPages } from '#modules/personal-pages/service';
import { drainRequestMessages } from '../../messages';
import { provisionRequestDesk } from '../../service';

// Private Slack messages about requests. Slack is replaced by a fetch stub; the
// database, the routes and the access checks are real.

const WORKSPACE = 'T1';
let posts: { channel: string; text: string }[];
let slackIds: Record<string, string>;
let emails: Record<string, string>;
let rateLimitPosts: number;
let fetchSpy: ReturnType<typeof spyOn>;

function stubSlack() {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://slack.com/api/')) throw new Error(`unexpected fetch ${url}`);
    const method = url.slice('https://slack.com/api/'.length);
    const args = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    if (method === 'users.lookupByEmail') {
      const id = slackIds[args.email!];
      return Response.json(
        id
          ? { ok: true, user: { id, team_id: WORKSPACE } }
          : { ok: false, error: 'users_not_found' },
      );
    }
    if (method === 'users.info')
      return Response.json({
        ok: true,
        user: { team_id: WORKSPACE, profile: { email: emails[args.user!] } },
      });
    if (method === 'chat.postMessage' && rateLimitPosts > 0) {
      rateLimitPosts -= 1;
      return new Response('', { status: 429, headers: { 'retry-after': '30' } });
    }
    posts.push({ channel: args.channel!, text: args.text! });
    return Response.json({ ok: true });
  }) as typeof fetch);
}

async function onSlack(person: TestUser, slackId: string) {
  slackIds[person.email] = slackId;
  emails[slackId] = person.email;
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, person.userId));
}

const to = (slackId: string) => posts.filter((p) => p.channel === slackId).map((p) => p.text);

describe('request messages', () => {
  const saved = {
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_TEAM_ID: process.env.SLACK_TEAM_ID,
    APP_URL: process.env.APP_URL,
  };

  beforeEach(async () => {
    await resetDb();
    Object.assign(process.env, {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_TEAM_ID: WORKSPACE,
      APP_URL: 'https://plan.example',
    });
    posts = [];
    slackIds = {};
    emails = {};
    rateLimitPosts = 0;
    stubSlack();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function world() {
    const god = await signUpTestUser({ name: 'Owner' });
    const priya = await signUpTestUser({ name: 'Priya' });
    const rahul = await signUpTestUser({ name: 'Rahul' });
    const ankit = await signUpTestUser({ name: 'Ankit' });
    await authedApi(god.cookie).god['frnd-requests'].put({ enabled: true });
    await provisionPersonalPages();
    await provisionRequestDesk();
    await onSlack(priya, 'UPRIYA');
    await onSlack(rahul, 'URAHUL');
    await onSlack(ankit, 'UANKIT');
    const desk = authedApi(priya.cookie).projects({ projectKey: 'REQ' });
    const columnId = (await desk.get()).data!.columns[0]!.id;
    const asked = await desk.issues.post({
      columnId,
      title: 'Review my PR #42',
      assigneeUserId: rahul.userId,
    });
    return { god, priya, rahul, ankit, request: asked.data! };
  }

  it('tells the assignee in their own DM, and nobody else', async () => {
    await world();
    await drainRequestMessages();
    expect(to('URAHUL')).toEqual([
      'Priya assigned you a request: <https://plan.example/project/REQ/issue/1|REQ-1> Review my PR #42',
    ]);
    expect(to('UANKIT')).toEqual([]);
    expect(to('UPRIYA')).toEqual([]);
  });

  it('tells someone added, and tells someone removed without the title', async () => {
    const { priya, ankit, request } = await world();
    const people = authedApi(priya.cookie).issues({ issueId: request.id }).participants;
    await people({ userId: ankit.userId }).put();
    await drainRequestMessages();
    expect(to('UANKIT')).toEqual([
      'Priya added you to a request: <https://plan.example/project/REQ/issue/1|REQ-1> Review my PR #42',
    ]);
    await people({ userId: ankit.userId }).delete();
    await drainRequestMessages();
    expect(to('UANKIT').at(-1)).toBe('You no longer have access to request REQ-1.');
  });

  it('tells the people in it about a comment, but not someone mentioned outside it', async () => {
    const { priya, ankit, request } = await world();
    await drainRequestMessages();
    await authedApi(priya.cookie)
      .issues({ issueId: request.id })
      .comments.post({ body: `@${ankit.username} fyi` });
    await drainRequestMessages();
    expect(to('URAHUL').at(-1)).toContain('Priya commented on');
    expect(to('UANKIT')).toEqual([]);
  });

  it('skips a message for someone removed before it was sent', async () => {
    const { priya, ankit, request } = await world();
    const people = authedApi(priya.cookie).issues({ issueId: request.id }).participants;
    await people({ userId: ankit.userId }).put();
    await people({ userId: ankit.userId }).delete();
    await drainRequestMessages();
    expect(to('UANKIT')).toEqual(['You no longer have access to request REQ-1.']);
  });

  it('respects the opt-out and sends each message once', async () => {
    const { rahul } = await world();
    await authedApi(rahul.cookie).account.preferences.patch({ slackReminders: false });
    await drainRequestMessages();
    await drainRequestMessages();
    expect(to('URAHUL')).toEqual([]);
    const rows = await db.select().from(slackRequestMessage);
    expect(rows.map((r) => r.outcome)).toEqual(['opted_out']);
  });

  it('waits when Slack rate limits, then sends once', async () => {
    await world();
    rateLimitPosts = 1;
    await drainRequestMessages();
    expect(to('URAHUL')).toEqual([]);
    await db.update(slackRequestMessage).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    await drainRequestMessages();
    await drainRequestMessages();
    expect(to('URAHUL')).toHaveLength(1);
  });

  it('sends nothing for an ordinary project', async () => {
    const { priya, rahul } = await world();
    const asPriya = authedApi(priya.cookie);
    await asPriya.projects.post({ key: 'MKT', name: 'Marketing' });
    const invite = await asPriya
      .projects({ projectKey: 'MKT' })
      .invites.post({ email: rahul.email, role: 'member' });
    await authedApi(rahul.cookie).invites({ token: invite.data!.token }).accept.post();
    const columnId = (await asPriya.projects({ projectKey: 'MKT' }).get()).data!.columns[0]!.id;
    await db.delete(slackRequestMessage);
    const task = await asPriya
      .projects({ projectKey: 'MKT' })
      .issues.post({ columnId, title: 'Normal task', assigneeUserId: rahul.userId });
    expect(task.status).toBe(201);
    expect(await db.select().from(slackRequestMessage)).toEqual([]);
  });
});
