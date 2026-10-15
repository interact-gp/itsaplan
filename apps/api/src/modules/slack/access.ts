import {
  db,
  isOrganizationAdmin,
  organizationGroups,
  project,
  projectMember,
  scimGroup,
  scimGroupMember,
  teamMember,
  user,
  userSlackAccount,
} from '@repo/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { activeUser } from '#shared/auth-context';
import { HttpError } from '#shared/lib';
import { getMemberContext } from '#modules/members/service';
import { hasPermission } from '#shared/permissions';
import { escapeSlack } from './client';

// Whether the account may use the app now: it exists, is active and has application
// access. Any other error is thrown, so the event is tried again.
export async function usable(userId: string): Promise<boolean> {
  try {
    return Boolean(await activeUser(userId));
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
}

// Whether the person may use the app and read the project's tasks, which is what
// assigning them a task and sending them its title takes. Project membership alone is
// not enough: a role can deny reading work items.
export async function canReadIssues(projectId: number, userId: string): Promise<boolean> {
  if (!(await usable(userId))) return false;
  const context = await getMemberContext(projectId, userId);
  return Boolean(
    context &&
    (context.role === 'owner' || hasPermission(context.permissions, 'work_items', 'read')),
  );
}

// Who a person without access to the project is told to ask: a project owner, else an
// owner or manager of its team, else an organization admin, any of whom can add them.
// Only an account that may use the app now is named, mentioned in Slack when it is
// linked there.
async function accessContact(
  projectId: number,
  recipientId: string,
  slackTeamId: string,
): Promise<string | null> {
  const owners = db
    .select({
      userId: projectMember.userId,
      rank: sql<number>`0`.as('rank'),
      since: projectMember.createdAt,
    })
    .from(projectMember)
    .where(and(eq(projectMember.projectId, projectId), eq(projectMember.role, 'owner')));
  const teamAdmins = db
    .select({
      userId: teamMember.userId,
      rank: sql<number>`1`.as('rank'),
      since: teamMember.createdAt,
    })
    .from(teamMember)
    .innerJoin(project, eq(project.teamId, teamMember.teamId))
    .where(and(eq(project.id, projectId), inArray(teamMember.role, ['owner', 'manager'])));
  const orgAdmins = db
    .select({
      userId: scimGroupMember.userId,
      rank: sql<number>`2`.as('rank'),
      since: scimGroup.createdAt,
    })
    .from(scimGroupMember)
    .innerJoin(scimGroup, eq(scimGroup.id, scimGroupMember.groupId))
    .where(eq(scimGroup.displayName, organizationGroups.admin));
  const candidates = owners.unionAll(teamAdmins).unionAll(orgAdmins).as('candidate');
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      rank: candidates.rank,
      slackUserId: userSlackAccount.slackUserId,
    })
    .from(candidates)
    .innerJoin(user, eq(user.id, candidates.userId))
    .leftJoin(
      userSlackAccount,
      and(eq(userSlackAccount.userId, user.id), eq(userSlackAccount.slackTeamId, slackTeamId)),
    )
    .where(and(eq(user.active, true), ne(user.id, recipientId)))
    .orderBy(asc(candidates.rank), asc(candidates.since), asc(user.createdAt));
  for (const row of rows) {
    if (row.rank === 2 && !(await isOrganizationAdmin(row.id))) continue;
    if (await usable(row.id))
      return row.slackUserId ? `<@${row.slackUserId}>` : escapeSlack(row.name);
  }
  return null;
}

// The message for someone assigned a task in a project they cannot read: the title and
// the project only, and who to ask for access.
export async function noAccessMessage(
  recipientId: string,
  title: string,
  projectId: number,
  projectName: string,
): Promise<string> {
  const contact = await accessContact(projectId, recipientId, process.env.SLACK_TEAM_ID ?? '');
  return (
    `You were assigned "${escapeSlack(title)}" in ${escapeSlack(projectName)}, but you don't currently have access. ` +
    (contact ? `Contact ${contact} to request access.` : 'Ask a project owner for access.')
  );
}
