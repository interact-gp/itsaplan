import {
  db,
  hasApplicationAccess,
  issue,
  managedAccess,
  project,
  projectColumn,
  slackRequestMessage,
  user,
  userPreference,
} from '@repo/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { isIssueVisible } from '#shared/issue-visibility';
import { canReadIssues, noAccessMessage } from '#modules/slack/access';
import { escapeSlack, postDirect, SlackApiError } from '#modules/slack/client';
import { slackUserFor } from '#modules/slack-reminders/service';

// Private Slack messages about requests: each person in a request hears in their own
// Slack DM that they were assigned or added, mentioned, that it was commented on or
// moved, or that they were removed. Messages are queued with the write and sent by a
// background loop, which checks the person's access again first. Nothing goes to a
// channel, and a removed person is told only the request's number, not its title.

export type RequestMessageKind =
  'assigned' | 'added' | 'removed' | 'mentioned' | 'commented' | 'state_changed';

export interface RequestMessageInput {
  userId: string;
  issueId: number;
  kind: RequestMessageKind;
  actorName: string | null;
  // Names the event, so the same event queues one message however often it is written.
  dedupeKey: string;
}

const MAX_ATTEMPTS = 5;
const BATCH = 20;
const LEASE = sql`interval '2 minutes'`;

// Queues the messages that concern requests and drops the rest: an issue of an
// ordinary project gets no Slack message from here.
export async function queueRequestMessages(rows: RequestMessageInput[]): Promise<void> {
  if (!rows.length) return;
  const requests = await db
    .select({ id: issue.id })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .where(
      and(
        inArray(
          issue.id,
          rows.map((r) => r.issueId),
        ),
        eq(project.participantOnly, true),
      ),
    );
  const ids = new Set(requests.map((r) => r.id));
  const queued = rows.filter((r) => ids.has(r.issueId));
  if (!queued.length) return;
  await db.insert(slackRequestMessage).values(queued).onConflictDoNothing();
}

type Message = typeof slackRequestMessage.$inferSelect;
type Outcome = { status: 'sent' | 'skipped'; outcome: string };

function appUrl(path: string) {
  return process.env.APP_URL ? `${process.env.APP_URL}${path}` : undefined;
}

async function sendMessage(message: Message): Promise<Outcome> {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_TEAM_ID)
    return { status: 'skipped', outcome: 'slack_not_configured' };
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
    .where(eq(user.id, message.userId));
  if (!member || member.active === false) return { status: 'skipped', outcome: 'inactive' };
  if (managedAccess() && !(await hasApplicationAccess(member.id)))
    return { status: 'skipped', outcome: 'no_access' };
  if (member.optedIn === false) return { status: 'skipped', outcome: 'opted_out' };

  const [request] = await db
    .select({
      key: project.key,
      projectId: project.id,
      projectName: project.name,
      number: issue.sequenceNumber,
      title: issue.title,
      state: projectColumn.name,
    })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(eq(issue.id, message.issueId));
  if (!request) return { status: 'skipped', outcome: 'deleted' };

  // Someone removed is told so; everyone else only while they can still see it.
  const visible = await isIssueVisible(message.issueId, member.id);
  if (message.kind === 'removed' ? visible : !visible)
    return { status: 'skipped', outcome: 'no_longer_applies' };
  // The request also needs the project: an assignee without it is told who can give it,
  // and nobody else is told anything.
  const readable =
    message.kind === 'removed' || (await canReadIssues(request.projectId, member.id));
  if (!readable && message.kind !== 'assigned') return { status: 'skipped', outcome: 'no_access' };

  const slackUserId = await slackUserFor(member);
  if (!slackUserId) return { status: 'skipped', outcome: 'no_slack_account' };
  if (!readable) {
    await postDirect(
      slackUserId,
      await noAccessMessage(member.id, request.title, request.projectId, request.projectName),
    );
    return { status: 'sent', outcome: 'sent_no_access' };
  }

  const ref = `${request.key}-${request.number}`;
  const url = appUrl(`/project/${request.key}/issue/${request.number}`);
  const shown = `${url ? `<${url}|${ref}>` : ref} ${escapeSlack(request.title)}`;
  const who = escapeSlack(message.actorName ?? 'Someone');
  const text = {
    assigned: `${who} assigned you a request: ${shown}`,
    added: `${who} added you to a request: ${shown}`,
    mentioned: `${who} mentioned you on ${shown}`,
    commented: `${who} commented on ${shown}`,
    state_changed: `${shown} is now ${escapeSlack(request.state)}`,
    removed: `You no longer have access to request ${ref}.`,
  }[message.kind as RequestMessageKind];
  await postDirect(slackUserId, text);
  return { status: 'sent', outcome: 'sent' };
}

async function finish(row: Message, status: string, outcome: string, retryAt?: Date) {
  await db
    .update(slackRequestMessage)
    .set({ status, outcome, updatedAt: sql`now()`, ...(retryAt ? { nextAttemptAt: retryAt } : {}) })
    .where(and(eq(slackRequestMessage.id, row.id), eq(slackRequestMessage.attempts, row.attempts)));
}

// Sends one claimed message. When Slack rate limits the bot, every pending message
// waits as long as Slack asked. Only ids, statuses and Slack error codes are logged.
async function deliver(row: Message): Promise<string> {
  try {
    const result = await sendMessage(row);
    await finish(row, result.status, result.outcome);
    return result.outcome;
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : 'error';
    console.error(`[frnd-requests] message ${row.id} attempt ${row.attempts} failed: ${code}`);
    if (row.attempts >= MAX_ATTEMPTS) {
      await finish(row, 'failed', code);
      return code;
    }
    const limited = error instanceof SlackApiError && error.retryAfterSeconds !== undefined;
    const retryAt = new Date(
      Date.now() + (limited ? error.retryAfterSeconds! : 60 * 2 ** row.attempts) * 1000,
    );
    await finish(row, 'pending', code, retryAt);
    if (limited)
      await db
        .update(slackRequestMessage)
        .set({ nextAttemptAt: retryAt })
        .where(
          and(
            eq(slackRequestMessage.status, 'pending'),
            lt(slackRequestMessage.nextAttemptAt, retryAt),
          ),
        );
    return code;
  }
}

// Claims due messages one at a time and sends each before claiming the next. Stops
// when Slack rate limits the bot.
export async function drainRequestMessages(): Promise<void> {
  for (let i = 0; i < BATCH; i++) {
    const [row] = await db.execute<Message>(sql`
      UPDATE ${slackRequestMessage}
      SET attempts = attempts + 1, next_attempt_at = now() + ${LEASE}, updated_at = now()
      WHERE id = (
        SELECT id FROM ${slackRequestMessage}
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, user_id AS "userId", issue_id AS "issueId", kind,
        actor_name AS "actorName", attempts`);
    if (!row) return;
    if ((await deliver(row)) === 'ratelimited') return;
  }
}
