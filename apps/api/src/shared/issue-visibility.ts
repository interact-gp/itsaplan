import { db, issue, issueParticipant, project } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';

// Who may see an issue. In an ordinary project that is everyone the project lets in.
// In a participant-only project it is only the issue's creator, its current assignee
// and the participants added to it, whatever role the member holds: project owners
// and organization administrators get no override. Every read of issue data ANDs
// this in, after the project-level checks.
export function issueVisibleTo(userId: string | null) {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM ${project}
      WHERE ${project.id} = ${issue.projectId} AND ${project.participantOnly}
    )
    OR ${issue.createdByUserId} = ${userId}
    OR ${issue.assigneeUserId} = ${userId}
    OR EXISTS (
      SELECT 1 FROM ${issueParticipant}
      WHERE ${issueParticipant.issueId} = ${issue.id} AND ${issueParticipant.userId} = ${userId}
    )
  )`;
}

// The project of an issue `userId` may see, or null when it does not exist or is
// hidden from them, which the caller answers with the same 404.
export async function visibleIssueProjectId(
  issueId: number,
  userId: string | null,
): Promise<number | null> {
  if (!Number.isInteger(issueId)) return null;
  const [row] = await db
    .select({ projectId: issue.projectId })
    .from(issue)
    .where(and(eq(issue.id, issueId), issueVisibleTo(userId)));
  return row?.projectId ?? null;
}

export async function isIssueVisible(issueId: number, userId: string | null) {
  return (await visibleIssueProjectId(issueId, userId)) !== null;
}

// Whether the project keeps each issue to its participants.
export async function isParticipantOnlyProject(projectId: number): Promise<boolean> {
  const [row] = await db
    .select({ participantOnly: project.participantOnly })
    .from(project)
    .where(eq(project.id, projectId));
  return row?.participantOnly ?? false;
}
