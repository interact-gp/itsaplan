import { db, issue, project, slackBotMessage, slackEvent } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import { escapeSlack, postDirect, postInThread, postPrivately } from './client';
import { canReadIssues } from './access';

// The replies the bot owes for a task it created: the confirmation (in the thread, or
// to the sender only) and the assignee's direct message. Each row is sent on its own
// and retried on its own, so one failing does not hold back the other or make the task
// a second time. The text is built when the message is sent, after the assignee's
// access to the task is checked again.

export type BotMessageKind = 'thread_reply' | 'private_reply' | 'assignee';

const MAX_ATTEMPTS = 5;
const LEASE = sql`interval '2 minutes'`;

export async function queueBotMessages(
  rows: {
    eventId: string;
    kind: BotMessageKind;
    issueId: number;
    slackUserId: string;
    userId?: string;
  }[],
): Promise<void> {
  if (!rows.length) return;
  await db.insert(slackBotMessage).values(rows).onConflictDoNothing();
}

type Message = typeof slackBotMessage.$inferSelect;

function appUrl(path: string) {
  return process.env.APP_URL ? `${process.env.APP_URL}${path}` : undefined;
}

async function sendMessage(message: Message): Promise<string> {
  const [row] = await db
    .select({
      key: project.key,
      projectId: project.id,
      number: issue.sequenceNumber,
      title: issue.title,
      assigneeUserId: issue.assigneeUserId,
      archivedAt: issue.archivedAt,
      channelId: slackEvent.channelId,
      threadTs: slackEvent.threadTs,
      messageTs: slackEvent.messageTs,
      senderSlackId: slackEvent.slackUserId,
    })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .innerJoin(slackEvent, eq(slackEvent.eventId, message.eventId))
    .where(eq(issue.id, message.issueId));
  if (!row) return 'deleted';
  const ref = `${row.key}-${row.number}`;
  const url = appUrl(`/project/${row.key}/issue/${row.number}`);
  const label = url ? `<${url}|${ref}>` : ref;
  const shown = escapeSlack(row.title);

  if (message.kind === 'thread_reply') {
    await postInThread(row.channelId, row.threadTs, `Created ${label}: ${shown}`);
  } else if (message.kind === 'private_reply') {
    // Slack hides a private message in a thread that has no other replies.
    const thread = row.threadTs === row.messageTs ? undefined : row.threadTs;
    await postPrivately(row.channelId, thread, message.slackUserId, `Created ${label}: ${shown}`);
  } else {
    if (row.archivedAt || row.assigneeUserId !== message.userId) return 'no_longer_assigned';
    if (!message.userId || !(await canReadIssues(row.projectId, message.userId)))
      return 'no_access';
    await postDirect(
      message.slackUserId,
      `<@${row.senderSlackId}> assigned you ${label}: ${shown}`,
    );
  }
  return 'sent';
}

// Sends one claimed message, leaving it pending for a later try when Slack refuses it,
// until the attempts run out. Only ids and Slack error codes are logged.
async function deliver(message: Message): Promise<void> {
  let status: string;
  let outcome: string;
  try {
    outcome = await sendMessage(message);
    status = outcome === 'sent' ? 'sent' : 'skipped';
  } catch (error) {
    outcome = error instanceof Error ? error.message.slice(0, 200) : 'error';
    console.error(`[slack] message ${message.id} attempt ${message.attempts} failed`);
    status = message.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  }
  await db
    .update(slackBotMessage)
    .set({
      status,
      outcome,
      ...(status === 'pending'
        ? { nextAttemptAt: sql`now() + make_interval(mins => power(2, ${message.attempts})::int)` }
        : {}),
    })
    .where(and(eq(slackBotMessage.id, message.id), eq(slackBotMessage.attempts, message.attempts)));
}

const BATCH = 20;

// Claims due messages one at a time, optionally only one event's, and sends each.
export async function sendBotMessages(eventId?: string): Promise<void> {
  for (let i = 0; i < BATCH; i++) {
    const rows = await db.execute<Message>(sql`
      UPDATE ${slackBotMessage}
      SET attempts = attempts + 1, next_attempt_at = now() + ${LEASE}
      WHERE id = (
        SELECT id FROM ${slackBotMessage}
        WHERE status = 'pending' AND next_attempt_at <= now()
          ${eventId ? sql`AND event_id = ${eventId}` : sql``}
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, event_id AS "eventId", kind, issue_id AS "issueId",
        slack_user_id AS "slackUserId", user_id AS "userId", attempts`);
    const message = rows[0];
    if (!message) return;
    await deliver(message);
  }
}
