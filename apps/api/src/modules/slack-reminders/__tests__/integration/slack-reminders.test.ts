import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { db, slackReminderDelivery, user } from '@repo/db';
import { eq } from 'drizzle-orm';
import { authedApi, type Api } from '#tests/helpers/app';
import { signUpTestUser, type TestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { provisionPersonalPages } from '#modules/personal-pages/service';
import { drainReminders, scheduleReminders, sendTestReminder } from '../../service';

// The Slack digest of pending work. Slack is replaced by a fetch stub; the database,
// the routes and the permission checks are real.

const WORKSPACE = 'T1';

interface Sent {
  method: string;
  args: Record<string, string>;
}

let sent: Sent[];
// Slack users by email, and the email each Slack user's profile carries.
let slackUsers: Record<string, string>;
let profileEmail: Record<string, string>;
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
      const id = slackUsers[args.email!];
      return Response.json(
        id
          ? { ok: true, user: { id, team_id: WORKSPACE } }
          : { ok: false, error: 'users_not_found' },
      );
    }
    if (method === 'users.info') {
      return Response.json({
        ok: true,
        user: { team_id: WORKSPACE, profile: { email: profileEmail[args.user!] } },
      });
    }
    if (method === 'chat.postMessage' && rateLimitPosts > 0) {
      rateLimitPosts -= 1;
      return new Response('', { status: 429, headers: { 'retry-after': '30' } });
    }
    sent.push({ method, args });
    return Response.json({ ok: true });
  }) as typeof fetch);
}

function dms() {
  return sent.filter((s) => s.method === 'chat.postMessage');
}

async function onSlack(person: TestUser, slackId: string) {
  slackUsers[person.email] = slackId;
  profileEmail[slackId] = person.email;
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, person.userId));
}

const checklist = (items: [string, boolean][]) => ({
  type: 'doc',
  content: [
    {
      type: 'taskList',
      content: items.map(([text, checked]) => ({
        type: 'taskItem',
        attrs: { checked },
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })),
    },
  ],
});

async function writeTodos(person: TestUser, items: [string, boolean][]) {
  const api = authedApi(person.cookie);
  const { projectKey, documentId } = (await api.account['personal-page'].get()).data!;
  const page = api.projects({ projectKey }).documents({ documentId });
  const current = (await page.get()).data!;
  await page.patch({ version: current.version, contentJson: checklist(items) });
}

async function assign(asOwner: Api, assigneeUserId: string, title: string, state: string) {
  const project = (await asOwner.projects({ projectKey: 'MKT' }).get()).data!;
  const columnId = project.columns.find((c) => c.stateType === state)!.id;
  await asOwner.projects({ projectKey: 'MKT' }).issues.post({ columnId, title, assigneeUserId });
}

describe('Slack reminders', () => {
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
    sent = [];
    slackUsers = {};
    profileEmail = {};
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
    const admin = await signUpTestUser({ name: 'Admin' });
    const asAdmin = authedApi(admin.cookie);
    await asAdmin.projects.post({ key: 'MKT', name: 'Marketing' });
    const member = await signUpTestUser({ name: 'Member' });
    const invite = await asAdmin
      .projects({ projectKey: 'MKT' })
      .invites.post({ email: member.email, role: 'member' });
    await authedApi(member.cookie).invites({ token: invite.data!.token }).accept.post();
    await provisionPersonalPages();
    await onSlack(admin, 'UADMIN');
    await onSlack(member, 'UMEMBER');
    return { admin, asAdmin, member };
  }

  it('sends the member their unticked to-dos and open assigned work, privately', async () => {
    const { admin, asAdmin } = await world();
    await writeTodos(admin, [
      ['Send weekly report', true],
      ['Review PR', false],
      ['Book <!channel> room', false],
    ]);
    await assign(asAdmin, admin.userId, 'Fix login', 'unstarted');
    await assign(asAdmin, admin.userId, 'Plan backlog', 'backlog');
    await assign(asAdmin, admin.userId, 'Ship release', 'completed');

    const result = await sendTestReminder(admin.userId);
    expect(result).toEqual({ status: 'sent', outcome: 'sent' });
    const [dm] = dms();
    expect(dm!.args.channel).toBe('UADMIN');
    expect(dm!.args.text).toContain('Review PR');
    expect(dm!.args.text).toContain('Book &lt;!channel&gt; room');
    expect(dm!.args.text).not.toContain('Send weekly report');
    expect(dm!.args.text).toContain('<https://plan.example/project/MKT/issue/1|MKT-1> Fix login');
    expect(dm!.args.text).toContain('Plan backlog');
    expect(dm!.args.text).not.toContain('Ship release');
  });

  it('sends nothing when there is nothing pending', async () => {
    const { admin } = await world();
    await writeTodos(admin, [['Done already', true]]);
    expect(await sendTestReminder(admin.userId)).toEqual({
      status: 'skipped',
      outcome: 'nothing_pending',
    });
    expect(dms()).toHaveLength(0);
  });

  it('sends nothing to a member who turned reminders off', async () => {
    const { admin } = await world();
    await writeTodos(admin, [['Review PR', false]]);
    await authedApi(admin.cookie).account.preferences.patch({ slackReminders: false });
    expect((await sendTestReminder(admin.userId)).outcome).toBe('opted_out');
    expect(dms()).toHaveLength(0);
  });

  it('sends nothing without a matching Slack account', async () => {
    const { admin, member } = await world();
    await writeTodos(member, [['Review PR', false]]);
    delete slackUsers[member.email];
    expect((await sendTestReminder(member.userId)).outcome).toBe('no_slack_account');

    await writeTodos(admin, [['Review PR', false]]);
    profileEmail.UADMIN = 'someone-else@example.com';
    expect((await sendTestReminder(admin.userId)).outcome).toBe('no_slack_account');
    expect(dms()).toHaveLength(0);
  });

  it('leaves out work in a project the member can no longer open', async () => {
    const { asAdmin, member } = await world();
    await assign(asAdmin, member.userId, 'Old task', 'unstarted');
    await asAdmin.projects({ projectKey: 'MKT' }).members({ userId: member.userId }).delete();
    expect((await sendTestReminder(member.userId)).outcome).toBe('nothing_pending');
    expect(dms()).toHaveLength(0);
  });

  it('sends nothing to a deactivated member', async () => {
    const { member } = await world();
    await writeTodos(member, [['Review PR', false]]);
    await db.update(user).set({ active: false }).where(eq(user.id, member.userId));
    expect((await sendTestReminder(member.userId)).outcome).toBe('inactive');
  });

  it('does not run on a schedule until one is set, then queues each member once', async () => {
    const { admin, asAdmin, member } = await world();
    await writeTodos(member, [['Review PR', false]]);
    await scheduleReminders();
    expect(await db.select().from(slackReminderDelivery)).toHaveLength(0);

    const set = await asAdmin.god['slack-reminders'].put({
      enabled: true,
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Kolkata',
    });
    expect(set.status).toBe(200);
    const due = new Date(set.data!.nextRunAt!);
    await scheduleReminders(new Date(due.getTime() + 1000));
    await scheduleReminders(new Date(due.getTime() + 2000));
    const queued = await db.select().from(slackReminderDelivery);
    expect(queued.map((r) => r.userId).sort()).toEqual([admin.userId, member.userId].sort());

    await drainReminders();
    await drainReminders();
    expect(dms().map((d) => d.args.channel)).toEqual(['UMEMBER']);
  });

  it('waits as long as Slack asks when it rate limits, then sends once', async () => {
    const { member } = await world();
    await writeTodos(member, [['Review PR', false]]);
    rateLimitPosts = 1;
    expect(await sendTestReminder(member.userId)).toEqual({
      status: 'pending',
      outcome: 'ratelimited',
    });
    const [row] = await db.select().from(slackReminderDelivery);
    const wait = row!.nextAttemptAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(20_000);
    expect(wait).toBeLessThan(40_000);

    await db.update(slackReminderDelivery).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    await drainReminders();
    await drainReminders();
    expect(dms()).toHaveLength(1);
  });

  it('keeps the schedule and the test to administrators and checks the schedule', async () => {
    const { asAdmin, member } = await world();
    const asMember = authedApi(member.cookie);
    expect((await asMember.god['slack-reminders'].get()).status).toBe(403);
    expect((await asMember.god['slack-reminders'].test.post()).status).toBe(403);
    const reminders = asAdmin.god['slack-reminders'];
    expect((await reminders.get()).data).toMatchObject({ enabled: false, slackConfigured: true });
    expect((await reminders.put({ enabled: true, cron: 'nope', timezone: 'UTC' })).status).toBe(
      400,
    );
    expect(
      (await reminders.put({ enabled: true, cron: '*/5 * * * *', timezone: 'UTC' })).status,
    ).toBe(400);
    expect(
      (await reminders.put({ enabled: true, cron: '0 9 * * *', timezone: 'Mars/Base' })).status,
    ).toBe(400);
  });

  it('stops sending to everyone while Slack asks it to wait', async () => {
    const { admin, member } = await world();
    await writeTodos(admin, [['Review PR', false]]);
    await writeTodos(member, [['Review PR', false]]);
    await db.insert(slackReminderDelivery).values([
      { userId: admin.userId, scheduledFor: new Date(), trigger: 'manual' },
      { userId: member.userId, scheduledFor: new Date(), trigger: 'manual' },
    ]);
    rateLimitPosts = 1;
    await drainReminders();
    expect(dms()).toHaveLength(0);
    const rows = await db.select().from(slackReminderDelivery);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.every((r) => r.nextAttemptAt.getTime() - Date.now() > 20_000)).toBe(true);
  });

  it('sends nothing queued by a schedule that was turned off before sending', async () => {
    const { asAdmin, member } = await world();
    await writeTodos(member, [['Review PR', false]]);
    const set = await asAdmin.god['slack-reminders'].put({
      enabled: true,
      cron: '0 9 * * *',
      timezone: 'UTC',
    });
    await scheduleReminders(new Date(new Date(set.data!.nextRunAt!).getTime() + 1000));
    await asAdmin.god['slack-reminders'].put({
      enabled: false,
      cron: '0 9 * * *',
      timezone: 'UTC',
    });
    await drainReminders();
    expect(dms()).toHaveLength(0);
    expect((await asAdmin.god['slack-reminders'].get()).data!.enabled).toBe(false);
  });
});
