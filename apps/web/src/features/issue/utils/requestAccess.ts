import type { Issue } from '@/lib/api/endpoints/issues';

// Who may reassign a request in a participant-only project and choose its people: the
// person who asked and the current assignee.
export function managesRequest(
  issue: Pick<Issue, 'createdByUserId' | 'assigneeUserId'>,
  userId: string | null,
) {
  return userId !== null && (userId === issue.createdByUserId || userId === issue.assigneeUserId);
}
