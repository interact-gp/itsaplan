import {
  aiAgent,
  db,
  hasApplicationAccess,
  issue,
  issueParticipant,
  issueWatcher,
  managedAccess,
  project,
  user,
} from '@repo/db';
import { and, asc, eq, isNull, ne, or } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { isIssueVisible } from '#shared/issue-visibility';
import { getMembership } from '#modules/members/service';
import { recordActivity, userName, userSide } from './activity';
import { autoWatchIssue } from './watchers';
import { queueRequestMessages } from '#modules/frnd-requests/messages';

// The people added to an issue of a participant-only project, besides its creator and
// its current assignee. Only those two manage the list: a participant collaborates on
// the issue but cannot give anyone else access to it.

export interface IssueParticipantRow {
  userId: string;
  name: string;
  image: string | null;
  addedByUserId: string | null;
}

async function participantIssue(issueId: number) {
  const [row] = await db
    .select({
      projectId: issue.projectId,
      createdByUserId: issue.createdByUserId,
      assigneeUserId: issue.assigneeUserId,
      participantOnly: project.participantOnly,
    })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .where(eq(issue.id, issueId));
  if (!row) throw new HttpError(404, 'Issue not found');
  if (!row.participantOnly)
    throw new HttpError(400, 'Participants are only kept on issues of a private request project');
  return row;
}

// Whether `userId` may change who has access to the issue: its creator or its current
// assignee.
export function managesAccess(
  row: { createdByUserId: string | null; assigneeUserId: string | null },
  userId: string,
) {
  return row.createdByUserId === userId || row.assigneeUserId === userId;
}

// An enabled person who may use the app and belongs to the project. Agents are
// excluded: a request is between people.
export async function assertEligiblePerson(projectId: number, userId: string, what: string) {
  const [person] = await db
    .select({ id: user.id })
    .from(user)
    .leftJoin(aiAgent, eq(aiAgent.userId, user.id))
    .where(
      and(eq(user.id, userId), or(isNull(user.active), ne(user.active, false)), isNull(aiAgent.id)),
    );
  if (
    !person ||
    !(await getMembership(projectId, userId)) ||
    (managedAccess() && !(await hasApplicationAccess(userId)))
  )
    throw new HttpError(400, `${what} must be an enabled member of this project`);
}

export async function listIssueParticipants(issueId: number): Promise<IssueParticipantRow[]> {
  return db
    .select({
      userId: issueParticipant.userId,
      name: user.name,
      image: user.image,
      addedByUserId: issueParticipant.addedByUserId,
    })
    .from(issueParticipant)
    .innerJoin(user, eq(user.id, issueParticipant.userId))
    .where(eq(issueParticipant.issueId, issueId))
    .orderBy(asc(user.name));
}

export async function addIssueParticipant(
  issueId: number,
  actorUserId: string,
  userId: string,
): Promise<IssueParticipantRow[]> {
  const row = await participantIssue(issueId);
  if (!managesAccess(row, actorUserId))
    throw new HttpError(403, 'Only the requester or the assignee can add people');
  await assertEligiblePerson(row.projectId, userId, 'A participant');
  const inserted = await db
    .insert(issueParticipant)
    .values({ issueId, userId, addedByUserId: actorUserId })
    .onConflictDoNothing()
    .returning({ userId: issueParticipant.userId });
  if (inserted.length) {
    const [entry] = await recordActivity(
      issueId,
      [{ action: 'participant_added', subject: await userSide(userId) }],
      actorUserId,
    );
    await autoWatchIssue(row.projectId, issueId, [userId]);
    await queueRequestMessages([
      {
        userId,
        issueId,
        kind: 'added',
        actorName: await userName(actorUserId),
        dedupeKey: `activity:${entry!.id}`,
      },
    ]);
  }
  return listIssueParticipants(issueId);
}

// Removing someone ends their access at once. Their watch row goes too, so nothing
// about the issue reaches them afterwards.
export async function removeIssueParticipant(
  issueId: number,
  actorUserId: string,
  userId: string,
): Promise<IssueParticipantRow[]> {
  const row = await participantIssue(issueId);
  if (!managesAccess(row, actorUserId))
    throw new HttpError(403, 'Only the requester or the assignee can remove people');
  const removed = await db
    .delete(issueParticipant)
    .where(and(eq(issueParticipant.issueId, issueId), eq(issueParticipant.userId, userId)))
    .returning({ userId: issueParticipant.userId });
  if (!removed.length) throw new HttpError(404, 'Not a participant of this issue');
  await dropWatcherWithoutAccess(issueId, userId);
  const [entry] = await recordActivity(
    issueId,
    [{ action: 'participant_removed', subject: await userSide(userId) }],
    actorUserId,
  );
  await queueRequestMessages([
    {
      userId,
      issueId,
      kind: 'removed',
      actorName: await userName(actorUserId),
      dedupeKey: `activity:${entry!.id}`,
    },
  ]);
  return listIssueParticipants(issueId);
}

// Deletes someone's watch row once they can no longer see the issue.
export async function dropWatcherWithoutAccess(issueId: number, userId: string | null) {
  if (!userId || (await isIssueVisible(issueId, userId))) return;
  await db
    .delete(issueWatcher)
    .where(and(eq(issueWatcher.issueId, issueId), eq(issueWatcher.userId, userId)));
}
