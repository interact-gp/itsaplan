import { db, projectColumn, slackEvent, user, userSlackAccount } from '@repo/db';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { slackProfile } from './client';

export interface SlackMention {
  eventId: string;
  slackTeamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  slackUserId: string;
  text: string;
}

export type SlackEventStatus = 'clarify' | 'done' | 'refused' | 'failed';

// How long an accepted event may stay unfinished before it counts as interrupted, and
// how often one is tried before it is left failed.
const STALE = sql`interval '2 minutes'`;
const MAX_ATTEMPTS = 5;

// Records the event with its whole message before Slack is answered, so nothing it
// asked for depends on the work that follows. False when the event id was seen and
// is finished or still being worked on, which is how a Slack retry of the same
// delivery is dropped: two concurrent claims cannot both succeed. A redelivery of one
// that failed or was interrupted claims it again.
export async function claimSlackEvent(
  mention: SlackMention,
  botUserId: string | undefined,
): Promise<boolean> {
  const rows = await db
    .insert(slackEvent)
    .values({
      eventId: mention.eventId,
      slackTeamId: mention.slackTeamId,
      channelId: mention.channelId,
      messageTs: mention.messageTs,
      threadTs: mention.threadTs,
      slackUserId: mention.slackUserId,
      botUserId: botUserId ?? null,
      request: mention.text,
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: slackEvent.eventId,
      set: {
        status: 'received',
        attempts: sql`${slackEvent.attempts} + 1`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${slackEvent.attempts} < ${MAX_ATTEMPTS} AND (${slackEvent.status} = 'failed' OR (${slackEvent.status} = 'received' AND ${slackEvent.updatedAt} < now() - ${STALE}))`,
    })
    .returning({ eventId: slackEvent.eventId });
  return rows.length > 0;
}

export type StoredEvent = typeof slackEvent.$inferSelect;

export async function storedEvent(eventId: string): Promise<StoredEvent | null> {
  const [row] = await db.select().from(slackEvent).where(eq(slackEvent.eventId, eventId));
  return row ?? null;
}

// The next event to try again: one that failed and is due, or one left unfinished
// past the time a run takes. Claiming it moves it forward, so no two runs take it.
export async function claimRetry(): Promise<StoredEvent | null> {
  const rows = await db.execute<StoredEvent>(sql`
    UPDATE ${slackEvent}
    SET status = 'received', attempts = attempts + 1, updated_at = now()
    WHERE event_id = (
      SELECT event_id FROM ${slackEvent}
      WHERE attempts < ${MAX_ATTEMPTS} AND (
        (status = 'failed' AND next_attempt_at <= now())
        OR (status = 'received' AND updated_at < now() - ${STALE})
      )
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING event_id AS "eventId", slack_team_id AS "slackTeamId", channel_id AS "channelId",
      message_ts AS "messageTs", thread_ts AS "threadTs", slack_user_id AS "slackUserId",
      bot_user_id AS "botUserId", request`);
  return rows[0] ?? null;
}

// Keeps what the request has become, so a retry starts from it.
export async function saveRequest(eventId: string, request: string) {
  await db
    .update(slackEvent)
    .set({ request, updatedAt: sql`now()` })
    .where(eq(slackEvent.eventId, eventId));
}

// The task created for this event: it is linked in the transaction that creates it.
export async function createdIssueId(eventId: string): Promise<number | null> {
  const [row] = await db
    .select({ issueId: slackEvent.issueId })
    .from(slackEvent)
    .where(eq(slackEvent.eventId, eventId));
  return row?.issueId ?? null;
}

export async function finishSlackEvent(
  eventId: string,
  outcome: {
    status: SlackEventStatus;
    userId?: string;
    request?: string;
    issueId?: number;
    projectId?: number;
  },
) {
  await db
    .update(slackEvent)
    .set({ ...outcome, updatedAt: sql`now()` })
    .where(eq(slackEvent.eventId, eventId));
}

// Marks an event failed unless it already has an outcome, and schedules the next try
// further out each time. An error raised after the task was created or a question was
// asked does not undo that outcome.
export async function failSlackEvent(eventId: string) {
  await db
    .update(slackEvent)
    .set({
      status: 'failed',
      updatedAt: sql`now()`,
      nextAttemptAt: sql`now() + make_interval(mins => power(2, ${slackEvent.attempts})::int)`,
    })
    .where(and(eq(slackEvent.eventId, eventId), eq(slackEvent.status, 'received')));
}

// How long a question waits for its answer: one asked in the channel itself for an
// answer posted in the channel, and one asked in a thread for an answer in that thread.
// A later mention is a new request.
const CHANNEL_ANSWER_MINUTES = 10;
const THREAD_ANSWER_HOURS = 24;

// The request this sender left waiting for an answer: in this thread in the last day,
// or, for a message posted in the channel itself, the latest one asked in the channel in
// the last few minutes.
export async function findPendingRequest(
  mention: SlackMention,
): Promise<{ eventId: string; request: string } | null> {
  const inThread = mention.threadTs !== mention.messageTs;
  const [pending] = await db
    .select({ eventId: slackEvent.eventId, request: slackEvent.request })
    .from(slackEvent)
    .where(
      and(
        eq(slackEvent.channelId, mention.channelId),
        eq(slackEvent.slackUserId, mention.slackUserId),
        eq(slackEvent.status, 'clarify'),
        inThread
          ? and(
              eq(slackEvent.threadTs, mention.threadTs),
              gt(slackEvent.createdAt, sql`now() - make_interval(hours => ${THREAD_ANSWER_HOURS})`),
            )
          : and(
              eq(slackEvent.threadTs, slackEvent.messageTs),
              gt(
                slackEvent.createdAt,
                sql`now() - make_interval(mins => ${CHANNEL_ANSWER_MINUTES})`,
              ),
            ),
      ),
    )
    .orderBy(desc(slackEvent.createdAt))
    .limit(1);
  return pending ?? null;
}

// Marks a waiting request answered. False when another answer took it first, so two
// answers handled at the same time complete it once.
export async function claimPendingRequest(eventId: string): Promise<boolean> {
  const rows = await db
    .update(slackEvent)
    .set({ status: 'done' })
    .where(and(eq(slackEvent.eventId, eventId), eq(slackEvent.status, 'clarify')))
    .returning({ eventId: slackEvent.eventId });
  return rows.length > 0;
}

// The product account a Slack user acts as, or null. A first contact links the two
// when the address on the Slack profile (which Slack verifies) belongs to an account
// whose own address is verified. A deleted or bot Slack user, or one from another
// workspace, is never linked.
export async function resolveSlackUser(
  slackTeamId: string,
  slackUserId: string,
): Promise<string | null> {
  const [linked] = await db
    .select({ userId: userSlackAccount.userId })
    .from(userSlackAccount)
    .where(
      and(
        eq(userSlackAccount.slackTeamId, slackTeamId),
        eq(userSlackAccount.slackUserId, slackUserId),
      ),
    );
  if (linked) return linked.userId;

  const profile = await slackProfile(slackUserId);
  if (!profile.email || profile.deleted || profile.isBot || profile.teamId !== slackTeamId)
    return null;
  const [account] = await db
    .select({ id: user.id })
    .from(user)
    .where(
      and(eq(sql`lower(${user.email})`, profile.email.toLowerCase()), eq(user.emailVerified, true)),
    );
  if (!account) return null;
  await db
    .insert(userSlackAccount)
    .values({ slackTeamId, slackUserId, userId: account.id })
    .onConflictDoNothing();
  return account.id;
}

// Where a task created from Slack starts: the first "unstarted" column, else the
// first column of the board.
export async function defaultColumnId(projectId: number): Promise<number | null> {
  const [column] = await db
    .select({ id: projectColumn.id })
    .from(projectColumn)
    .where(eq(projectColumn.projectId, projectId))
    .orderBy(sql`${projectColumn.stateType} <> 'unstarted'`, asc(projectColumn.position))
    .limit(1);
  return column?.id ?? null;
}
