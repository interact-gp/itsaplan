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

// Records the event. False when the event id was seen before, which is how a Slack
// retry of the same delivery is dropped: two concurrent inserts cannot both succeed.
export async function claimSlackEvent(mention: SlackMention): Promise<boolean> {
  const rows = await db
    .insert(slackEvent)
    .values({
      eventId: mention.eventId,
      slackTeamId: mention.slackTeamId,
      channelId: mention.channelId,
      messageTs: mention.messageTs,
      threadTs: mention.threadTs,
      slackUserId: mention.slackUserId,
    })
    .onConflictDoNothing()
    .returning({ eventId: slackEvent.eventId });
  return rows.length > 0;
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
  await db.update(slackEvent).set(outcome).where(eq(slackEvent.eventId, eventId));
}

// Marks an event failed unless it already has an outcome: an error raised while
// replying must not hide a task that was created or a question that was asked.
export async function failSlackEvent(eventId: string) {
  await db
    .update(slackEvent)
    .set({ status: 'failed' })
    .where(and(eq(slackEvent.eventId, eventId), eq(slackEvent.status, 'received')));
}

// How long a question asked in the channel itself waits for an answer posted in the
// channel. An answer in the thread of the request has no limit.
const CHANNEL_ANSWER_MINUTES = 10;

// The request this sender left waiting for an answer: in this thread, or, for a message
// posted in the channel itself, the latest one asked in the channel in the last few
// minutes.
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
          ? eq(slackEvent.threadTs, mention.threadTs)
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
