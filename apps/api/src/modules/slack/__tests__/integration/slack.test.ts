import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  db,
  organizationGroups,
  projectColumn,
  scimGroup,
  scimGroupMember,
  setSetting,
  slackBotMessage,
  slackEvent,
  user,
} from '@repo/db';
import { eq } from 'drizzle-orm';
import { app, authedApi, type Api } from '#tests/helpers/app';
import { signUpTestUser, type TestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { createRole, teamIdOf } from '#tests/helpers/roles';
import { retrySlackWork, slackWorkSettled } from '../../handler';

// The Slack bot: a signed @mention becomes a task or project created as the Slack
// user who sent it, through the same route and permission checks as the web app.
// Slack and OpenRouter are replaced by a fetch stub; everything else is real.

const SECRET = 'slack-signing-secret';
const WORKSPACE = 'T1';
const BOT = 'UBOT';

interface Sent {
  method: string;
  args: Record<string, string>;
}

let sent: Sent[];
let profiles: Record<string, string>;
// What the Jev stub answers per question; anything not offered as an option becomes none.
let jev: Record<string, string>;
let title: string;
// The request text each title was written from.
let titleRequests: string[];
// Slack methods the stub answers with an error.
let failing: Set<string>;
// Channels (or user ids, for a direct message) chat.postMessage fails for.
let failingChannels: Set<string>;
let fetchSpy: ReturnType<typeof spyOn>;

function distribution(choice: string, options: string[]) {
  const all = [...options];
  const picked = all.includes(choice) ? choice : 'none';
  const rest = all.length > 1 ? 0.1 / (all.length - 1) : 0;
  return {
    type: 'choice',
    choice: picked,
    confidence: 0.9,
    probabilities: Object.fromEntries(all.map((o) => [o, o === picked ? 0.9 : rest])),
  };
}

function stubFetch() {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.slice('https://slack.com/api/'.length);
      const args = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
      // A message to a failing channel is refused and not recorded as sent.
      if (method === 'chat.postMessage' && failingChannels.has(args.channel!))
        return Response.json({ ok: false, error: 'internal_error' });
      sent.push({ method, args });
      if (failing.has(method)) return Response.json({ ok: false, error: 'internal_error' });
      if (method === 'users.info') {
        const email = profiles[args.user!];
        return Response.json({
          ok: true,
          user: { team_id: WORKSPACE, deleted: false, is_bot: false, profile: { email } },
        });
      }
      return Response.json({ ok: true });
    }
    if (url === 'https://openrouter.ai/api/alpha/decisions') {
      const { questions } = JSON.parse(String(init?.body)) as {
        questions: Record<string, { criteria: Record<string, string> }>;
      };
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [
          id,
          distribution(jev[id] ?? 'none', Object.keys(q.criteria)),
        ]),
      );
      return Response.json({ model: 'typesafe/jev-test', answers });
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      const { messages } = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      titleRequests.push(messages[1]!.content);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title }) } }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
}

function sign(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', SECRET).update(`v0:${timestamp}:${body}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': `v0=${signature}`,
  };
}

async function deliver(payload: unknown, headers?: Record<string, string>) {
  const body = JSON.stringify(payload);
  const response = await app.handle(
    new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: headers ?? sign(body),
      body,
    }),
  );
  await slackWorkSettled();
  return response;
}

let eventCounter = 0;
function mention(
  slackUser: string,
  text: string,
  opts: { eventId?: string; threadTs?: string; team?: string } = {},
) {
  eventCounter += 1;
  const ts = `1700000000.${String(eventCounter).padStart(6, '0')}`;
  return {
    type: 'event_callback',
    team_id: opts.team ?? WORKSPACE,
    event_id: opts.eventId ?? `Ev${eventCounter}`,
    authorizations: [{ user_id: BOT }],
    event: {
      type: 'app_mention',
      user: slackUser,
      text: `<@${BOT}> ${text}`,
      ts,
      channel: 'C1',
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    },
  };
}

async function verified(person: TestUser, slackId: string) {
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, person.userId));
  profiles[slackId] = person.email;
}

// Turns on Keycloak-managed access and puts each person in an organization group, the
// way the identity-provider sync does.
async function managed(people: [TestUser, 'admin' | 'member'][]) {
  process.env.ITSAPLAN_MANAGED_ACCESS = 'true';
  for (const [person, rank] of people) {
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
  await setSetting('organization.lastSync', Date.now());
}

async function join(asOwner: Api, projectKey: string, person: TestUser, roleId?: number) {
  const invite = await asOwner
    .projects({ projectKey })
    .invites.post({ email: person.email, role: 'member', roleId });
  await authedApi(person.cookie).invites({ token: invite.data!.token }).accept.post();
}

async function issues(asOwner: Api, projectKey = 'MKT') {
  const list = await asOwner.projects({ projectKey }).issues.get({ query: {} });
  return list.data!;
}

function replies(method: string) {
  return sent.filter((s) => s.method === method).map((s) => s.args);
}

interface World {
  owner: TestUser;
  asOwner: Api;
  member: TestUser;
  outsider: TestUser;
  teamId: number;
}

async function world(): Promise<World> {
  await signUpTestUser(); // the first account is god; act as ordinary users below
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await asOwner.projects.post({ key: 'MKT', name: 'Marketing' });
  await asOwner.projects.post({ key: 'OPS', name: 'Operations' });
  const teamId = await teamIdOf(asOwner, 'MKT');
  const mkt = (await asOwner.projects({ projectKey: 'MKT' }).get()).data!;
  const ops = (await asOwner.projects({ projectKey: 'OPS' }).get()).data!;
  await asOwner.teams({ teamId }).mcp.patch({
    enabled: true,
    projects: [
      { projectId: mkt.project.id, enabled: true },
      { projectId: ops.project.id, enabled: true },
    ],
  });
  const member = await signUpTestUser({ name: 'Member' });
  await join(asOwner, 'MKT', member);
  const outsider = await signUpTestUser({ name: 'Outsider' });
  await verified(owner, 'UOWNER');
  await verified(member, 'UMEMBER');
  await verified(outsider, 'UOUT');
  return { owner, asOwner, member, outsider, teamId };
}

describe('Slack bot', () => {
  const saved = {
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_TEAM_ID: process.env.SLACK_TEAM_ID,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    APP_URL: process.env.APP_URL,
    ITSAPLAN_MANAGED_ACCESS: process.env.ITSAPLAN_MANAGED_ACCESS,
  };

  beforeEach(async () => {
    await resetDb();
    Object.assign(process.env, {
      SLACK_SIGNING_SECRET: SECRET,
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_TEAM_ID: WORKSPACE,
      OPENROUTER_API_KEY: 'test-key',
      APP_URL: 'https://plan.example',
      ITSAPLAN_MANAGED_ACCESS: 'false',
    });
    sent = [];
    profiles = {};
    jev = { tool: 'create_issue', project: 'MKT' };
    title = 'Fix push notifications';
    titleRequests = [];
    failing = new Set();
    failingChannels = new Set();
    stubFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('request verification', () => {
    it('answers the URL verification challenge only when signed', async () => {
      const ok = await deliver({ type: 'url_verification', challenge: 'abc' });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ challenge: 'abc' });

      const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
      const forged = await deliver(JSON.parse(body), {
        ...sign(body),
        'x-slack-signature': 'v0=' + '0'.repeat(64),
      });
      expect(forged.status).toBe(401);
    });

    it('refuses a replayed request older than five minutes', async () => {
      await world();
      const payload = mention('UMEMBER', 'create a task in MKT to fix push notifications');
      const body = JSON.stringify(payload);
      const old = await deliver(payload, sign(body, Math.floor(Date.now() / 1000) - 600));
      expect(old.status).toBe(401);
      expect(sent).toHaveLength(0);
    });

    it('is off until Slack is configured', async () => {
      delete process.env.SLACK_SIGNING_SECRET;
      expect((await deliver({ type: 'url_verification', challenge: 'abc' })).status).toBe(404);
    });

    it('ignores events from another workspace', async () => {
      const { asOwner } = await world();
      await deliver(mention('UMEMBER', 'create a task in MKT to fix it', { team: 'T2' }));
      expect(await issues(asOwner)).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });
  });

  describe('creating a task', () => {
    it('creates an assigned task as the sender and tells the thread and the assignee', async () => {
      const { asOwner, member } = await world();
      const response = await deliver(
        mention('UOWNER', 'create a task in MKT to fix push notifications and assign <@UMEMBER>'),
      );
      expect(response.status).toBe(200);

      const created = await issues(asOwner);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        title: 'Fix push notifications',
        assigneeUserId: member.userId,
      });
      const [thread] = replies('chat.postMessage').filter((m) => m.thread_ts);
      expect(thread!.channel).toBe('C1');
      expect(thread!.text).toContain('<https://plan.example/project/MKT/issue/1|MKT-1>');
      const [direct] = replies('chat.postMessage').filter((m) => m.channel === 'UMEMBER');
      expect(direct!.text).toContain('<@UOWNER> assigned you');
    });

    it('creates one task when Slack retries the same event', async () => {
      const { asOwner } = await world();
      const payload = mention('UMEMBER', 'create a task in MKT to fix push notifications', {
        eventId: 'EvSame',
      });
      await deliver(payload);
      await deliver(payload);
      expect(await issues(asOwner)).toHaveLength(1);
      expect(replies('chat.postMessage').filter((m) => m.thread_ts)).toHaveLength(1);
    });

    it('asks which project when the target is not clear, then completes in the thread', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue' };
      const first = mention('UOWNER', 'create a task to fix push notifications');
      await deliver(first);
      expect(await issues(asOwner)).toHaveLength(0);
      const [question] = replies('chat.postEphemeral');
      expect(question!.user).toBe('UOWNER');
      expect(question!.text).toContain('MKT (Marketing)');
      expect(question!.text).toContain('OPS (Operations)');

      await deliver(mention('UOWNER', 'OPS', { threadTs: first.event.ts }));
      expect(await issues(asOwner, 'OPS')).toHaveLength(1);
      expect(await issues(asOwner)).toHaveLength(0);
    });

    it('does not read a project key out of an ordinary lowercase word', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue' };
      await deliver(mention('UOWNER', 'create a task to fix the ops dashboard'));
      expect(await issues(asOwner, 'OPS')).toHaveLength(0);
      expect(replies('chat.postEphemeral')[0]!.text).toContain('Which project');
    });

    it('asks in the channel for a channel message and in the thread for a thread reply', async () => {
      await world();
      jev = { tool: 'create_issue' };
      const first = mention('UOWNER', 'create a task to fix push notifications');
      await deliver(first);
      await deliver(
        mention('UOWNER', 'create a task to fix login', { threadTs: '1699999999.000001' }),
      );
      const [inChannel, inThread] = replies('chat.postEphemeral');
      expect(inChannel!.thread_ts).toBeUndefined();
      expect(inChannel!.text).toContain('Mention me again with one of');
      expect(inThread!.thread_ts).toBe('1699999999.000001');
    });

    it('tells only the sender where the task went when Jev chose the project', async () => {
      const { asOwner } = await world();
      await deliver(mention('UOWNER', 'add a task to draft the launch email'));
      expect(await issues(asOwner)).toHaveLength(1);
      expect(replies('chat.postMessage')).toHaveLength(0);
      expect(replies('chat.postEphemeral')[0]!.text).toContain('MKT-1');
    });

    it('takes an answer posted in the channel, but not a new request', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue' };
      await deliver(mention('UOWNER', 'create a task to fix push notifications'));
      await deliver(mention('UOWNER', 'OPS'));
      expect(await issues(asOwner, 'OPS')).toHaveLength(1);
      expect(titleRequests.at(-1)).toBe('create a task to fix push notifications\nOPS');

      await deliver(mention('UOWNER', 'create a task to fix login'));
      jev = { tool: 'create_issue', project: 'MKT' };
      await deliver(mention('UOWNER', 'create a task in MKT to fix the footer'));
      expect(titleRequests.at(-1)).toBe('create a task in MKT to fix the footer');
    });

    it('does not take a channel answer once the question is old, nor make it a task', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue' };
      await deliver(mention('UOWNER', 'create a task to fix push notifications'));
      await db.update(slackEvent).set({ createdAt: new Date(Date.now() - 11 * 60_000) });
      await deliver(mention('UOWNER', 'OPS'));
      expect(await issues(asOwner, 'OPS')).toHaveLength(0);
      expect(replies('chat.postEphemeral').at(-1)!.text).toContain('No request is waiting');
    });

    it('completes a waiting request once when two answers arrive together', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue' };
      const first = mention('UOWNER', 'create a task to fix push notifications');
      await deliver(first);
      await Promise.all([
        deliver(mention('UOWNER', 'OPS', { threadTs: first.event.ts })),
        deliver(mention('UOWNER', 'OPS', { threadTs: first.event.ts })),
      ]);
      expect(await issues(asOwner, 'OPS')).toHaveLength(1);
    });

    it('does not take a project name used as an ordinary word as the target', async () => {
      const { asOwner } = await world();
      delete process.env.OPENROUTER_API_KEY;
      await deliver(mention('UOWNER', 'create a task in NOPE to update the marketing banner'));
      expect(await issues(asOwner)).toHaveLength(0);
      expect(replies('chat.postEphemeral')[0]!.text).toContain('Which project');
    });

    it('takes a project named after "in", or given by name as the answer to its question', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue' };
      await deliver(mention('UOWNER', 'create a task in the marketing project to fix login'));
      expect(await issues(asOwner)).toHaveLength(1);
      const first = mention('UOWNER', 'create a task to fix push notifications');
      await deliver(first);
      await deliver(mention('UOWNER', 'Operations', { threadTs: first.event.ts }));
      expect(await issues(asOwner, 'OPS')).toHaveLength(1);
    });

    it('posts user-written text so it cannot ping the channel or disguise a link', async () => {
      const { asOwner } = await world();
      title = 'Fix <!channel> and <https://evil.example|docs> & more';
      await deliver(mention('UOWNER', 'create a task in MKT to fix login and assign <@UMEMBER>'));
      expect(await issues(asOwner)).toHaveLength(1);
      const posted = replies('chat.postMessage').map((m) => m.text!);
      expect(posted).toHaveLength(2);
      for (const text of posted) {
        expect(text).not.toContain('<!channel>');
        expect(text).not.toContain('<https://evil.example');
        expect(text).toContain('&lt;!channel&gt; and &lt;https://evil.example|docs&gt; &amp; more');
      }
    });

    it('takes a task about a project as a task', async () => {
      const { asOwner } = await world();
      await deliver(mention('UOWNER', 'create a task in MKT to add project filters to the board'));
      expect(await issues(asOwner)).toHaveLength(1);
    });

    it('asks for the request when the mention has no text', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue' };
      const first = mention('UOWNER', '');
      await deliver(first);
      expect(replies('chat.postEphemeral')[0]!.text).toContain('Write the request');
      await deliver(mention('UOWNER', 'MKT', { threadTs: first.event.ts }));
      expect(await issues(asOwner)).toHaveLength(0);
    });

    it('treats a mention in an old question thread as a new request', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue' };
      const first = mention('UOWNER', 'create a task to fix push notifications');
      await deliver(first);
      await db.update(slackEvent).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) });
      await deliver(
        mention('UOWNER', 'create a task in OPS to rotate keys', { threadTs: first.event.ts }),
      );
      expect(titleRequests.at(-1)).toBe('create a task in OPS to rotate keys');
      expect(await issues(asOwner, 'OPS')).toHaveLength(1);
    });

    it('writes the request without Slack markup into the task', async () => {
      const { asOwner } = await world();
      delete process.env.OPENROUTER_API_KEY;
      await deliver(
        mention('UOWNER', 'create a task in MKT to fix A &amp; B, see <https://x.example|docs>'),
      );
      const [created] = await issues(asOwner);
      expect(created!.title).toBe(
        'create a task in MKT to fix A & B, see docs (https://x.example)',
      );
    });

    it('tells the sender once when the task cannot be created, and does not try again', async () => {
      const { asOwner } = await world();
      const mkt = (await asOwner.projects({ projectKey: 'MKT' }).get()).data!;
      await db.delete(projectColumn).where(eq(projectColumn.projectId, mkt.project.id));
      await deliver(mention('UOWNER', 'create a task in MKT to fix login'));
      await retrySlackWork();
      const told = replies('chat.postEphemeral').filter((m) =>
        m.text!.includes('could not create'),
      );
      expect(told).toHaveLength(1);
    });

    it('keeps a question pending when posting it to Slack fails', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue' };
      failing.add('chat.postEphemeral');
      const first = mention('UOWNER', 'create a task to fix push notifications');
      await deliver(first);
      await deliver(mention('UOWNER', 'OPS', { threadTs: first.event.ts }));
      expect(await issues(asOwner, 'OPS')).toHaveLength(1);
      expect(titleRequests.at(-1)).toBe('create a task to fix push notifications\nOPS');
    });

    it('does not create in a project the sender is not a member of', async () => {
      const { asOwner } = await world();
      jev = { tool: 'create_issue', project: 'OPS' };
      await deliver(mention('UMEMBER', 'create a task in OPS to fix push notifications'));
      expect(await issues(asOwner, 'OPS')).toHaveLength(0);
      const [question] = replies('chat.postEphemeral');
      expect(question!.text).toContain('Which project');
      expect(question!.text).not.toContain('OPS');
    });

    it('refuses an assignee who is not a project member and does not add them', async () => {
      const { asOwner, outsider } = await world();
      await deliver(mention('UOWNER', 'create a task in MKT to fix push and assign <@UOUT>'));
      expect(await issues(asOwner)).toHaveLength(0);
      const members = (await asOwner.projects({ projectKey: 'MKT' }).members.get()).data!;
      expect(JSON.stringify(members)).not.toContain(outsider.userId);
      expect(replies('chat.postEphemeral')[0]!.text).toContain('<@UOUT> is not a member of MKT');
    });

    it('denies a member whose role cannot create work items', async () => {
      const { asOwner } = await world();
      const viewer = await signUpTestUser({ name: 'Viewer' });
      const role = await createRole(asOwner, 'MKT', {
        name: 'Viewer',
        permissions: { work_items: { read: true, create: false } },
      });
      await join(asOwner, 'MKT', viewer, role.data!.id);
      await verified(viewer, 'UVIEW');
      await deliver(mention('UVIEW', 'create a task in MKT to fix push notifications'));
      expect(await issues(asOwner)).toHaveLength(0);
      expect(replies('chat.postEphemeral')).toHaveLength(1);
    });

    it('stops working once MCP access is turned off for the project', async () => {
      const { asOwner, teamId } = await world();
      await asOwner.teams({ teamId }).mcp.patch({ enabled: false });
      await deliver(mention('UMEMBER', 'create a task in MKT to fix push notifications'));
      expect(await issues(asOwner)).toHaveLength(0);
    });
  });

  describe('who may use the bot', () => {
    it('refuses a Slack user whose email matches no account', async () => {
      const { asOwner } = await world();
      profiles.USTRANGER = 'nobody@example.com';
      await deliver(mention('USTRANGER', 'create a task in MKT to fix push notifications'));
      expect(await issues(asOwner)).toHaveLength(0);
      expect(replies('chat.postEphemeral')[0]!.text).toContain(
        'could not match your Slack account',
      );
    });

    it('refuses an account whose email is not verified', async () => {
      const { asOwner } = await world();
      const unverified = await signUpTestUser({ name: 'Unverified' });
      await join(asOwner, 'MKT', unverified);
      await db.update(user).set({ emailVerified: false }).where(eq(user.id, unverified.userId));
      profiles.UNEW = unverified.email;
      await deliver(mention('UNEW', 'create a task in MKT to fix push notifications'));
      expect(await issues(asOwner)).toHaveLength(0);
    });

    it('refuses a deactivated account even after it was linked', async () => {
      const { asOwner, member } = await world();
      await deliver(mention('UMEMBER', 'create a task in MKT to fix push notifications'));
      expect(await issues(asOwner)).toHaveLength(1);
      await db.update(user).set({ active: false }).where(eq(user.id, member.userId));
      await deliver(mention('UMEMBER', 'create a task in MKT to fix push notifications'));
      expect(await issues(asOwner)).toHaveLength(1);
      expect(replies('chat.postEphemeral').at(-1)!.text).toContain('cannot use the app');
    });

    it('refuses a member whose application access was removed', async () => {
      const { owner, asOwner, member } = await world();
      await managed([
        [owner, 'member'],
        [member, 'member'],
      ]);
      await deliver(mention('UMEMBER', 'create a task in MKT to fix push notifications'));
      expect(await issues(asOwner)).toHaveLength(1);
      await db.delete(scimGroupMember).where(eq(scimGroupMember.userId, member.userId));
      await deliver(mention('UMEMBER', 'create a task in MKT to fix push notifications'));
      expect(await issues(asOwner)).toHaveLength(1);
      expect(replies('chat.postEphemeral').at(-1)!.text).toContain('cannot use the app');
    });

    it('lets an organization admin create in a project they are not a member of, without joining it', async () => {
      const { owner, asOwner } = await world();
      const admin = await signUpTestUser({ name: 'Admin' });
      await verified(admin, 'UADMIN');
      await managed([
        [owner, 'member'],
        [admin, 'admin'],
      ]);
      await deliver(mention('UADMIN', 'create a task in MKT to fix push notifications'));
      const created = await issues(asOwner);
      expect(created).toHaveLength(1);
      const [record] = await db.select().from(slackEvent);
      expect(record).toMatchObject({
        userId: admin.userId,
        status: 'done',
        issueId: created[0]!.id,
      });
      const members = (await asOwner.projects({ projectKey: 'MKT' }).members.get()).data!;
      expect(JSON.stringify(members)).not.toContain(admin.userId);
    });
  });

  describe('creating a project', () => {
    it('refuses to create a project, even for a team owner', async () => {
      const { asOwner, teamId } = await world();
      const team = (await asOwner.teams({ teamId }).get()).data!;
      const before = (await asOwner.projects.get()).data!.length;
      await deliver(mention('UOWNER', `create a project called Mobile app in ${team.name}`));
      expect((await asOwner.projects.get()).data).toHaveLength(before);
      expect(await issues(asOwner)).toHaveLength(0);
      expect(replies('chat.postMessage')).toHaveLength(0);
      expect(replies('chat.postEphemeral')[0]!.text).toContain(
        'I can only add tasks to existing projects',
      );
    });

    it('refuses to create a project or change members for an organization admin', async () => {
      const { owner, asOwner, teamId } = await world();
      const admin = await signUpTestUser({ name: 'Admin' });
      await verified(admin, 'UADMIN');
      await managed([
        [owner, 'member'],
        [admin, 'admin'],
      ]);
      const asAdmin = authedApi(admin.cookie);
      const team = (await asOwner.teams({ teamId }).get()).data!;
      const projectsBefore = (await asAdmin.projects.get()).data!.length;
      const membersBefore = (await asOwner.projects({ projectKey: 'MKT' }).members.get()).data;

      await deliver(mention('UADMIN', `create a project called Mobile app in ${team.name}`));
      await deliver(mention('UADMIN', 'make a new project for the launch'));

      expect((await asAdmin.projects.get()).data).toHaveLength(projectsBefore);
      expect((await asOwner.projects({ projectKey: 'MKT' }).members.get()).data).toEqual(
        membersBefore,
      );
      expect(await issues(asOwner)).toHaveLength(0);
      expect(replies('chat.postMessage')).toHaveLength(0);
      for (const reply of replies('chat.postEphemeral'))
        expect(reply.text).toContain('I can only add tasks to existing projects');
    });
  });

  // Found in review of PR #2. Each test reproduces one of the reported failures.
  describe('review fixes', () => {
    // Makes every queued retry due now, as the background loop would find it later.
    async function dueNow() {
      await db.update(slackEvent).set({ nextAttemptAt: new Date(Date.now() - 1000) });
      await db.update(slackBotMessage).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    }

    it('does not assign or message someone whose role cannot read tasks', async () => {
      const { asOwner } = await world();
      const viewer = await signUpTestUser({ name: 'No read' });
      const role = await createRole(asOwner, 'MKT', {
        name: 'No read',
        permissions: { work_items: { read: false } },
      });
      await join(asOwner, 'MKT', viewer, role.data!.id);
      await verified(viewer, 'UNOREAD');
      await deliver(mention('UOWNER', 'create a task in MKT to fix push and assign <@UNOREAD>'));
      expect(await issues(asOwner)).toHaveLength(0);
      expect(replies('chat.postMessage').filter((m) => m.channel === 'UNOREAD')).toEqual([]);
      expect(replies('chat.postEphemeral').at(-1)!.text).toContain('who can see its tasks');
    });

    it('checks the assignee again before a retried message is sent', async () => {
      const { asOwner, member } = await world();
      failingChannels.add('UMEMBER');
      await deliver(
        mention('UOWNER', 'create a task in MKT to fix push notifications and assign <@UMEMBER>'),
      );
      expect(await issues(asOwner)).toHaveLength(1);
      await db.update(user).set({ active: false }).where(eq(user.id, member.userId));
      failingChannels.clear();
      await dueNow();
      await retrySlackWork();
      expect(replies('chat.postMessage').filter((m) => m.channel === 'UMEMBER')).toEqual([]);
      const [dm] = await db
        .select()
        .from(slackBotMessage)
        .where(eq(slackBotMessage.kind, 'assignee'));
      expect(dm!.status).toBe('skipped');
    });

    it('keeps a request Slack sent while lookups failed, and creates it once later', async () => {
      const { asOwner } = await world();
      failing.add('users.info');
      const event = mention('UMEMBER', 'create a task in MKT to fix push notifications', {
        eventId: 'EvLost',
      });
      expect((await deliver(event)).status).toBe(200);
      expect(await issues(asOwner)).toHaveLength(0);
      const [stored] = await db.select().from(slackEvent).where(eq(slackEvent.eventId, 'EvLost'));
      expect(stored!.status).toBe('failed');
      expect(stored!.request).toContain('fix push notifications');

      failing.clear();
      await deliver(event);
      await dueNow();
      await retrySlackWork();
      expect(await issues(asOwner)).toHaveLength(1);
    });

    it('recovers an interrupted request without creating the task twice', async () => {
      const { asOwner } = await world();
      await deliver(
        mention('UMEMBER', 'create a task in MKT to fix push notifications', {
          eventId: 'EvCut',
        }),
      );
      expect(await issues(asOwner)).toHaveLength(1);
      // As if the process stopped after creating the task, before recording it.
      await db
        .update(slackEvent)
        .set({ status: 'received', issueId: null, updatedAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(slackEvent.eventId, 'EvCut'));
      await retrySlackWork();
      expect(await issues(asOwner)).toHaveLength(1);
      const [row] = await db.select().from(slackEvent).where(eq(slackEvent.eventId, 'EvCut'));
      expect(row!.status).toBe('done');
      expect(row!.issueId).not.toBeNull();
    });

    it('sends the assignee message even when the thread reply fails, and retries the reply alone', async () => {
      const { asOwner } = await world();
      failingChannels.add('C1');
      await deliver(
        mention('UOWNER', 'create a task in MKT to fix push notifications and assign <@UMEMBER>'),
      );
      expect(await issues(asOwner)).toHaveLength(1);
      expect(replies('chat.postMessage').filter((m) => m.channel === 'UMEMBER')).toHaveLength(1);
      expect(replies('chat.postMessage').filter((m) => m.thread_ts)).toHaveLength(0);

      failingChannels.clear();
      await dueNow();
      await retrySlackWork();
      expect(replies('chat.postMessage').filter((m) => m.thread_ts)).toHaveLength(1);
      expect(replies('chat.postMessage').filter((m) => m.channel === 'UMEMBER')).toHaveLength(1);
      expect(await issues(asOwner)).toHaveLength(1);
    });
  });
});
