import { db, organizationAccess, user, project, managedAccess } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { listTeams } from '#modules/teams/service';
import { listProjects } from '#modules/projects/service';
import { getTeamPermissions } from '#modules/members/service';
import { fullPermissions } from '#shared/permissions';
import { HttpError } from '#shared/lib';
import type { McpRouteTool } from './generate';

export interface DiscoveryScope {
  teamId?: number;
  projectId?: number;
}

export async function authorizedTools(
  table: McpRouteTool[],
  userId: string,
  scope: DiscoveryScope = {},
): Promise<McpRouteTool[]> {
  let teams = await listTeams(userId, { mcpOnly: true });
  let projects = await listProjects(userId, { mcpOnly: true, withPermissions: true });
  const managedTeamIds = teams
    .filter((t) => t.role === 'owner' || t.role === 'manager')
    .map((t) => t.id);
  let administeredProjects = managedTeamIds.length
    ? await db
        .select({ id: project.id, teamId: project.teamId })
        .from(project)
        .where(and(inArray(project.teamId, managedTeamIds), eq(project.mcpEnabled, true)))
    : [];
  if (scope.projectId !== undefined) {
    const target =
      projects.find((p) => p.id === scope.projectId) ??
      administeredProjects.find((p) => p.id === scope.projectId);
    if (!target || (scope.teamId !== undefined && target.teamId !== scope.teamId))
      throw new HttpError(404, 'Discovery scope not found');
    projects = projects.filter((p) => p.id === target.id);
    administeredProjects = administeredProjects.filter((p) => p.id === target.id);
    teams = teams.filter((t) => t.id === target.teamId);
  }
  if (scope.teamId !== undefined) {
    teams = teams.filter((t) => t.id === scope.teamId);
    if (!teams.length) throw new HttpError(404, 'Discovery scope not found');
    projects = projects.filter((p) => p.teamId === scope.teamId);
    administeredProjects = administeredProjects.filter((p) => p.teamId === scope.teamId);
  }
  const matrices = await Promise.all(
    teams.map((team) =>
      team.role === 'owner' || team.role === 'manager'
        ? fullPermissions()
        : getTeamPermissions(team.id, userId),
    ),
  );
  const [person] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
  const admin =
    !managedAccess() || person?.role === 'god' || (await organizationAccess(userId)).admin;
  return table.filter((tool) => {
    if (tool.name === 'create_project') return false;
    const eligibleProjects = tool.feature
      ? projects.filter((p) => p[`${tool.feature!}Enabled`])
      : projects;
    if (tool.feature && !eligibleProjects.length) return false;
    if (tool.access === 'organization-admin') return admin;
    if (tool.access === 'team-owner') return teams.some((t) => t.role === 'owner');
    if (tool.access === 'team-manager')
      return tool.pathParams.includes('projectKey')
        ? administeredProjects.length > 0
        : teams.some((t) => t.role === 'owner' || t.role === 'manager');
    if (tool.access === 'project-owner') return eligibleProjects.some((p) => p.role === 'owner');
    if (tool.access === 'project-admin')
      return eligibleProjects.some((p) => p.role === 'owner') || administeredProjects.length > 0;
    if (tool.pathParams.includes('teamId')) {
      if (!teams.length) return false;
      return (
        !tool.permission ||
        matrices.some((matrix) => matrix[tool.permission![0]][tool.permission![1]])
      );
    }
    if (tool.permission?.[0] === 'members_manage' && administeredProjects.length > 0) return true;
    if (tool.permission)
      return eligibleProjects.some(
        (p) => p.permissions?.[tool.permission![0]][tool.permission![1]],
      );
    if (tool.access === 'project-member' || tool.pathParams.includes('projectKey'))
      return eligibleProjects.length > 0;
    return true;
  });
}
