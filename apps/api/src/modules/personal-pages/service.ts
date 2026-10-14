import { randomUUID } from 'node:crypto';
import {
  aiAgent,
  db,
  emptyPermissions,
  hasApplicationAccess,
  managedAccess,
  project,
  projectDocument,
  projectMember,
  setSetting,
  team,
  teamMember,
  teamRole,
  user,
} from '@repo/db';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { createProject } from '#modules/projects/service';
import { insertOwnedTeam } from '#modules/teams/service';
import { personalWorkspace, WORKSPACE_SETTING, type PersonalWorkspace } from './workspace';

// Every member who may use the app gets one "My To-do" page: a personal document in
// the shared "Personal Notes" project of the "FRND Workspace" team. The team and the
// project belong to a system account nobody can sign in as, so they do not depend on
// a person who may leave.

// The project key, or the first of its numbered variants that is free when another
// project already holds it.
const PROJECT_KEYS = ['MYTODO', ...Array.from({ length: 8 }, (_, i) => `MYTODO${i + 2}`)];
// Serializes provisioning across api replicas; the value only has to differ from the
// other advisory locks in use.
const LOCK = 731926105;

type Ready = Required<PersonalWorkspace>;

// Members may read and edit pages but not create them, so the shared project holds
// nothing but the personal pages provisioning writes.
function memberPermissions() {
  const permissions = emptyPermissions();
  permissions.documents.read = true;
  permissions.documents.edit = true;
  return permissions;
}

// Creates what is missing of the workspace, one step at a time, and records each step
// as it completes, so a run that fails halfway resumes where it stopped.
// A recorded team or project that no longer exists is created again, and with a new
// team goes a new role and project.
async function ensureWorkspace(): Promise<Ready> {
  const saved = await personalWorkspace();
  const record = async (patch: PersonalWorkspace) => {
    Object.assign(saved, patch);
    await setSetting(WORKSPACE_SETTING, saved);
  };
  const exists = async (table: typeof team | typeof project, id: number | undefined) =>
    id !== undefined &&
    (await db.select({ id: table.id }).from(table).where(eq(table.id, id))).length > 0;
  if (!(await exists(team, saved.teamId))) {
    await record({ teamId: undefined, roleId: undefined, projectId: undefined });
  } else if (!(await exists(project, saved.projectId))) {
    await record({ projectId: undefined });
  }

  if (!saved.systemUserId) {
    const id = randomUUID();
    // No credential row and an address that cannot receive mail: nobody can sign in.
    await db.insert(user).values({
      id,
      name: 'Itsaplan system',
      email: `system+${id}@itsaplan.invalid`,
      emailVerified: false,
      active: false,
    });
    await record({ systemUserId: id });
  }
  if (!saved.teamId) {
    const created = await db.transaction((tx) =>
      insertOwnedTeam(tx, 'FRND Workspace', saved.systemUserId!),
    );
    await record({ teamId: created.team.id });
  }
  if (!saved.roleId) {
    const [role] = await db
      .insert(teamRole)
      .values({ teamId: saved.teamId!, name: 'Personal notes', permissions: memberPermissions() })
      .returning({ id: teamRole.id });
    await record({ roleId: role!.id });
  }
  if (!saved.projectId) {
    // A project this workspace's team already holds is adopted: an earlier run created
    // it and stopped before recording it.
    const taken = await db
      .select({ id: project.id, key: project.key, teamId: project.teamId })
      .from(project)
      .where(inArray(project.key, PROJECT_KEYS));
    const own = taken.find((p) => p.teamId === saved.teamId);
    const key = PROJECT_KEYS.find((k) => !taken.some((p) => p.key === k));
    if (own) {
      await record({ projectId: own.id });
    } else if (!key) {
      throw new Error('No free project key for the Personal Notes project');
    } else {
      const created = await createProject(
        { key, name: 'Personal Notes' },
        saved.systemUserId!,
        saved.teamId,
      );
      await record({ projectId: created.id });
    }
  }
  return saved as Ready;
}

// Members who may use the app but are missing their page or their membership of the
// shared project. Accounts behind AI agents and deactivated accounts are left out.
async function membersToProvision(workspace: Ready): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .leftJoin(aiAgent, eq(aiAgent.userId, user.id))
    .leftJoin(
      projectMember,
      and(eq(projectMember.userId, user.id), eq(projectMember.projectId, workspace.projectId)),
    )
    .leftJoin(
      projectDocument,
      and(eq(projectDocument.ownerUserId, user.id), eq(projectDocument.personal, true)),
    )
    .where(
      and(
        or(isNull(user.active), ne(user.active, false)),
        isNull(aiAgent.id),
        ne(user.id, workspace.systemUserId),
        or(isNull(projectMember.userId), isNull(projectDocument.id)),
      ),
    );
  const ids = rows.map((row) => row.id);
  if (!managedAccess()) return ids;
  const allowed = await Promise.all(ids.map((id) => hasApplicationAccess(id)));
  return ids.filter((_, i) => allowed[i]);
}

// Gives one member their membership and their page. Every insert does nothing when its
// row exists, so a retry, a second replica or a member who left the project converges
// on one page and one membership, and an existing page is never replaced.
async function provision(workspace: Ready, userId: string) {
  await db.transaction(async (tx) => {
    await tx
      .insert(teamMember)
      .values({ teamId: workspace.teamId, userId, role: 'member' })
      .onConflictDoNothing();
    await tx
      .insert(projectMember)
      .values({ projectId: workspace.projectId, userId, role: 'member', roleId: workspace.roleId })
      .onConflictDoNothing();
    await tx
      .insert(projectDocument)
      .values({
        projectId: workspace.projectId,
        title: 'My To-do',
        isPrivate: true,
        personal: true,
        ownerUserId: userId,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .onConflictDoNothing();
  });
}

// Run by a background loop. Each member is provisioned on their own, so one failure
// does not hold back the others, and the next run retries it.
export async function provisionPersonalPages(): Promise<void> {
  // The first person to sign up becomes the instance owner, which better-auth decides
  // by counting accounts. The system account must not be that first account.
  if ((await db.$count(user)) === 0) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK})`);
    const workspace = await ensureWorkspace();
    for (const userId of await membersToProvision(workspace)) {
      await provision(workspace, userId).catch((error) =>
        console.error('[personal-pages] provisioning failed for a member', error),
      );
    }
  });
}

// Where the member's page is, for the "My To-do" link.
export async function personalPageOf(
  userId: string,
): Promise<{ projectKey: string; documentId: number } | null> {
  const [row] = await db
    .select({ projectKey: project.key, documentId: projectDocument.id })
    .from(projectDocument)
    .innerJoin(project, eq(project.id, projectDocument.projectId))
    .where(and(eq(projectDocument.ownerUserId, userId), eq(projectDocument.personal, true)));
  return row ?? null;
}
