import {
  aiAgent,
  appSetting,
  db,
  getSetting,
  hasApplicationAccess,
  issue,
  managedAccess,
  project,
  projectColumn,
  projectDocument,
  setSetting,
  slackReminderDelivery,
  user,
  userPreference,
  userSlackAccount,
} from '@repo/db';
import { Cron } from 'croner';
import { and, asc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { listProjects } from '#modules/projects/service';
import {
  escapeSlack,
  postDirect,
  SlackApiError,
  slackProfile,
  slackUserByEmail,
} from '#modules/slack/client';
import { isValidTimezone } from '#modules/user-preferences/service';

// The scheduled private Slack digest: for each member, their unticked "My To-do" items
// and the work assigned to them that is not done, sent to their own Slack DM only.
// Recurring delivery is off until an administrator sets a schedule; a test sends one
// digest to the administrator who asks for it.

const SETTING = 'slackReminders';
const MAX_ATTEMPTS = 5;
const BATCH = 20;
// How long a claimed row stays out of other claims while it is being sent.
const LEASE = sql`interval '2 minutes'`;
const LIST_LIMIT = 10;
const MIN_INTERVAL_SECONDS = 3600;

export interface ReminderSettings {
  enabled: boolean;
  cron: string;
  timezone: string;
  nextRunAt: string | null;
}

const DEFAULTS: ReminderSettings = { enabled: false, cron: '', timezone: 'UTC', nextRunAt: null };

export async function getReminderSettings(): Promise<ReminderSettings> {
  return { ...DEFAULTS, ...(await getSetting<Partial<ReminderSettings>>(SETTING)) };
}

function schedule(cron: string, timezone: string) {
  try {
    return new Cron(cron, { timezone, paused: true });
  } catch {
    throw new HttpError(400, 'Invalid cron expression');
  }
}

export async function updateReminderSettings(input: {
  enabled: boolean;
  cron: string;
  timezone: string;
}): Promise<ReminderSettings> {
  if (!isValidTimezone(input.timezone)) throw new HttpError(400, 'Unknown timezone');
  let nextRunAt: string | null = null;
  if (input.enabled) {
    const runs = schedule(input.cron, input.timezone).nextRuns(3);
    if (runs.length < 2) throw new HttpError(400, 'Invalid cron expression');
    for (let i = 1; i < runs.length; i++) {
      if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_INTERVAL_SECONDS * 1000)
        throw new HttpError(400, 'Reminders can run at most once an hour');
    }
    nextRunAt = runs[0]!.toISOString();
  } else if (input.cron) {
    schedule(input.cron, input.timezone);
  }
  const settings = { ...input, nextRunAt };
  await setSetting(SETTING, settings);
  return settings;
}

// Queues one delivery per member when a scheduled time has come. A second pass, on
// this or another replica, queues nothing new for the same time.
export async function scheduleReminders(now = new Date()): Promise<void> {
  const settings = await getReminderSettings();
  if (!settings.enabled || !settings.nextRunAt || now < new Date(settings.nextRunAt)) return;
  const occurrence = new Date(settings.nextRunAt);
  const recipients = await db
    .select({ id: user.id })
    .from(user)
    .leftJoin(aiAgent, eq(aiAgent.userId, user.id))
    .where(and(or(isNull(user.active), ne(user.active, false)), isNull(aiAgent.id)));
  if (recipients.length) {
    await db
      .insert(slackReminderDelivery)
      .values(
        recipients.map((r) => ({ userId: r.id, scheduledFor: occurrence, trigger: 'schedule' })),
      )
      .onConflictDoNothing();
  }
  // Only the next run time moves, and only if nobody changed the schedule meanwhile, so
  // an administrator turning reminders off while this ran is not undone.
  const next = schedule(settings.cron, settings.timezone).nextRun(now);
  await db
    .update(appSetting)
    .set({
      value: sql`jsonb_set(${appSetting.value}, '{nextRunAt}', ${JSON.stringify(next?.toISOString() ?? null)}::jsonb)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(appSetting.key, SETTING),
        sql`${appSetting.value}->>'nextRunAt' = ${settings.nextRunAt}`,
      ),
    );
}

type Outcome = { status: 'sent' | 'skipped'; outcome: string };

function appUrl(path: string) {
  return process.env.APP_URL ? `${process.env.APP_URL}${path}` : undefined;
}

function link(url: string | undefined, label: string) {
  return url ? `<${url}|${escapeSlack(label)}>` : escapeSlack(label);
}

// The text of every unticked checklist item, in page order. Read from the editor's
// structured content, where a task item carries a checked flag; a page saved without
// it falls back to the Markdown task syntax.
export function untickedItems(
  contentJson: Record<string, unknown> | null,
  markdown: string,
): string[] {
  if (!contentJson) {
    return [...markdown.matchAll(/^\s*[-*+] \[ \] (.+)$/gm)].map((m) => m[1]!.trim());
  }
  const items: string[] = [];
  const text = (node: unknown): string => {
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text') return n.text ?? '';
    if (n.type === 'taskList') return '';
    return (n.content ?? []).map(text).join('');
  };
  const walk = (node: unknown) => {
    const n = node as { type?: string; attrs?: { checked?: unknown }; content?: unknown[] };
    if (n.type === 'taskItem' && n.attrs?.checked === false) {
      const label = text(n).trim();
      if (label) items.push(label);
    }
    for (const child of n.content ?? []) walk(child);
  };
  walk(contentJson);
  return items;
}

// The member's Slack user in the bot's workspace. A link made by the bot is reused;
// otherwise the verified address is looked up in Slack. Either way the Slack profile
// must still carry the member's address, so a reassigned Slack account gets nothing.
async function slackUserFor(member: { id: string; email: string; emailVerified: boolean }) {
  const workspace = process.env.SLACK_TEAM_ID!;
  const [linked] = await db
    .select({ slackUserId: userSlackAccount.slackUserId })
    .from(userSlackAccount)
    .where(
      and(eq(userSlackAccount.userId, member.id), eq(userSlackAccount.slackTeamId, workspace)),
    );
  let slackUserId = linked?.slackUserId;
  if (!slackUserId) {
    if (!member.emailVerified) return null;
    const found = await slackUserByEmail(member.email);
    if (!found || found.deleted || found.isBot || found.teamId !== workspace) return null;
    await db
      .insert(userSlackAccount)
      .values({ slackTeamId: workspace, slackUserId: found.id, userId: member.id })
      .onConflictDoNothing();
    slackUserId = found.id;
  }
  const profile = await slackProfile(slackUserId);
  if (
    profile.deleted ||
    profile.teamId !== workspace ||
    profile.email?.toLowerCase() !== member.email.toLowerCase()
  )
    return null;
  return slackUserId;
}

// Checks the member again and sends their digest. Every check runs at send time, so a
// member removed, deactivated or opted out since the row was queued gets nothing.
async function sendDigest(userId: string, trigger: string): Promise<Outcome> {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_TEAM_ID)
    return { status: 'skipped', outcome: 'slack_not_configured' };
  if (trigger === 'schedule' && !(await getReminderSettings()).enabled)
    return { status: 'skipped', outcome: 'schedule_off' };
  const [member] = await db
    .select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      active: user.active,
      optedIn: userPreference.slackReminders,
    })
    .from(user)
    .leftJoin(userPreference, eq(userPreference.userId, user.id))
    .where(eq(user.id, userId));
  if (!member || member.active === false) return { status: 'skipped', outcome: 'inactive' };
  if (managedAccess() && !(await hasApplicationAccess(userId)))
    return { status: 'skipped', outcome: 'no_access' };
  if (member.optedIn === false) return { status: 'skipped', outcome: 'opted_out' };

  const [page] = await db
    .select({
      id: projectDocument.id,
      projectKey: project.key,
      content: projectDocument.content,
      contentJson: projectDocument.contentJson,
    })
    .from(projectDocument)
    .innerJoin(project, eq(project.id, projectDocument.projectId))
    .where(and(eq(projectDocument.ownerUserId, userId), eq(projectDocument.personal, true)));
  const todos = page ? untickedItems(page.contentJson, page.content) : [];

  const readable = (await listProjects(userId, { withPermissions: true }))
    .filter((p) => p.permissions?.work_items.read)
    .map((p) => p.id);
  const assigned = readable.length
    ? await db
        .select({ key: project.key, number: issue.sequenceNumber, title: issue.title })
        .from(issue)
        .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
        .innerJoin(project, eq(project.id, issue.projectId))
        .where(
          and(
            eq(issue.assigneeUserId, userId),
            isNull(issue.archivedAt),
            inArray(issue.projectId, readable),
            notInArray(projectColumn.stateType, ['completed', 'canceled']),
          ),
        )
        .orderBy(asc(project.key), asc(issue.sequenceNumber))
    : [];
  if (!todos.length && !assigned.length) return { status: 'skipped', outcome: 'nothing_pending' };

  const slackUserId = await slackUserFor(member);
  if (!slackUserId) return { status: 'skipped', outcome: 'no_slack_account' };

  const more = (total: number) => (total > LIST_LIMIT ? [`…and ${total - LIST_LIMIT} more`] : []);
  const lines = ['*Your pending work in Itsaplan*'];
  if (todos.length) {
    const url = page ? appUrl(`/project/${page.projectKey}/docs/${page.id}`) : undefined;
    lines.push('', `${link(url, 'My To-do')} (${todos.length})`);
    lines.push(
      ...todos.slice(0, LIST_LIMIT).map((t) => `• ${escapeSlack(t)}`),
      ...more(todos.length),
    );
  }
  if (assigned.length) {
    lines.push('', `*Assigned to you* (${assigned.length})`);
    lines.push(
      ...assigned
        .slice(0, LIST_LIMIT)
        .map(
          (i) =>
            `• ${link(appUrl(`/project/${i.key}/issue/${i.number}`), `${i.key}-${i.number}`)} ${escapeSlack(i.title)}`,
        ),
      ...more(assigned.length),
    );
  }
  lines.push(
    '',
    '_Only you receive this message. Turn it off in Itsaplan under Account preferences._',
  );
  await postDirect(slackUserId, lines.join('\n'));
  return { status: 'sent', outcome: 'sent' };
}

type Delivery = typeof slackReminderDelivery.$inferSelect;

// Records how a claimed delivery ended. Matching the attempt count makes it a no-op for
// a row whose lease ran out and that another process claimed again.
async function finish(row: Delivery, status: string, outcome: string, retryAt?: Date) {
  await db
    .update(slackReminderDelivery)
    .set({
      status,
      outcome,
      updatedAt: sql`now()`,
      ...(retryAt ? { nextAttemptAt: retryAt } : {}),
    })
    .where(
      and(eq(slackReminderDelivery.id, row.id), eq(slackReminderDelivery.attempts, row.attempts)),
    );
}

// Sends one claimed delivery. A Slack failure leaves the row pending for a later
// attempt until the attempts run out. When Slack rate limits the bot, every pending
// delivery waits as long as Slack asked, not only this one. Only ids, statuses and
// Slack error codes are logged.
async function deliver(row: Delivery): Promise<{ status: string; outcome: string }> {
  try {
    const result = await sendDigest(row.userId, row.trigger);
    await finish(row, result.status, result.outcome);
    return result;
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : 'error';
    console.error(`[slack-reminders] delivery ${row.id} attempt ${row.attempts} failed: ${code}`);
    if (row.attempts >= MAX_ATTEMPTS) {
      await finish(row, 'failed', code);
      return { status: 'failed', outcome: code };
    }
    const limited = error instanceof SlackApiError && error.retryAfterSeconds !== undefined;
    const waitSeconds = limited ? error.retryAfterSeconds! : 60 * 2 ** row.attempts;
    const retryAt = new Date(Date.now() + waitSeconds * 1000);
    await finish(row, 'pending', code, retryAt);
    if (limited) {
      await db
        .update(slackReminderDelivery)
        .set({ nextAttemptAt: retryAt })
        .where(
          and(
            eq(slackReminderDelivery.status, 'pending'),
            lt(slackReminderDelivery.nextAttemptAt, retryAt),
          ),
        );
    }
    return { status: 'pending', outcome: code };
  }
}

// Claims due deliveries one at a time and sends each before claiming the next, so a
// claim never waits behind other sends long enough for its lease to run out. Stops
// when Slack rate limits the bot.
export async function drainReminders(): Promise<void> {
  for (let i = 0; i < BATCH; i++) {
    const [row] = await db.execute<Delivery>(sql`
      UPDATE ${slackReminderDelivery}
      SET attempts = attempts + 1, next_attempt_at = now() + ${LEASE}, updated_at = now()
      WHERE id = (
        SELECT id FROM ${slackReminderDelivery}
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, user_id AS "userId", trigger, attempts`);
    if (!row) return;
    if ((await deliver(row)).outcome === 'ratelimited') return;
  }
}

export async function runReminders(): Promise<void> {
  await scheduleReminders();
  await drainReminders();
}

// Sends the digest to the administrator who asks, at once. The row is recorded like
// a scheduled one and held out of the background claim while it is sent here.
export async function sendTestReminder(userId: string) {
  const [row] = await db
    .insert(slackReminderDelivery)
    .values({
      userId,
      scheduledFor: new Date(),
      trigger: 'manual',
      attempts: 1,
      nextAttemptAt: sql`now() + ${LEASE}`,
    })
    .returning();
  return deliver(row!);
}
