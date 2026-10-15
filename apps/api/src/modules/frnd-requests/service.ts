import {
  aiAgent,
  db,
  emptyPermissions,
  hasApplicationAccess,
  managedAccess,
  project,
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
import { personalWorkspace } from '#modules/personal-pages/workspace';
import { DESK_SETTING, requestDesk, type RequestDesk } from './desk';

// FRND Requests: a "General Requests" project, in a team of its own, where every
// member who may use the app can ask any other member for something. It keeps each
// request to the people in it (project.participant_only), so joining the project shows
// nobody else's requests. It belongs to the same system account as the Personal Notes
// workspace. Enrolling everyone stays off until an administrator turns it on, after the
// privacy has been checked.

const PROJECT_KEYS = ['REQ', ...Array.from({ length: 8 }, (_, i) => `REQ${i + 2}`)];
const LOCK = 731926106;

type Ready = Required<Omit<RequestDesk, 'enabled'>>;

// Under the provisioning lock, so a switch and a provisioning run never write the
// setting over each other.
export async function setRequestDeskEnabled(enabled: boolean): Promise<RequestDesk> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK})`);
    const desk = { ...(await requestDesk()), enabled };
    await setSetting(DESK_SETTING, desk);
    return desk;
  });
}

// Members create, read and work on requests. Which requests they see is decided per
// request, not by this role.
function memberPermissions() {
  const permissions = emptyPermissions();
  permissions.work_items.read = true;
  permissions.work_items.create = true;
  permissions.work_items.edit = true;
  for (const resource of ['states', 'issue_types', 'labels', 'custom_fields'] as const)
    permissions[resource].read = true;
  return permissions;
}

// Creates what is missing, one step at a time, recording each step as it completes.
// A recorded team or project that no longer exists is created again.
async function ensureDesk(systemUserId: string): Promise<Ready> {
  const saved = await requestDesk();
  const record = async (patch: RequestDesk) => {
    Object.assign(saved, patch);
    await setSetting(DESK_SETTING, saved);
  };
  const exists = async (table: typeof team | typeof project, id: number | undefined) =>
    id !== undefined &&
    (await db.select({ id: table.id }).from(table).where(eq(table.id, id))).length > 0;
  if (!(await exists(team, saved.teamId))) {
    await record({ teamId: undefined, roleId: undefined, projectId: undefined });
  } else if (!(await exists(project, saved.projectId))) {
    await record({ projectId: undefined });
  }

  if (!saved.teamId) {
    const created = await db.transaction((tx) =>
      insertOwnedTeam(tx, 'FRND Requests', systemUserId),
    );
    await record({ teamId: created.team.id });
  }
  if (!saved.roleId) {
    const [role] = await db
      .insert(teamRole)
      .values({ teamId: saved.teamId!, name: 'Requester', permissions: memberPermissions() })
      .returning({ id: teamRole.id });
    await record({ roleId: role!.id });
  }
  if (!saved.projectId) {
    const taken = await db
      .select({ id: project.id, key: project.key, teamId: project.teamId })
      .from(project)
      .where(inArray(project.key, PROJECT_KEYS));
    const own = taken.find((p) => p.teamId === saved.teamId);
    const key = PROJECT_KEYS.find((k) => !taken.some((p) => p.key === k));
    let projectId = own?.id;
    if (!projectId) {
      if (!key) throw new Error('No free project key for the General Requests project');
      projectId = (
        await createProject({ key, name: 'General Requests' }, systemUserId, saved.teamId)
      ).id;
    }
    // Set before anyone is enrolled, so the project never shows requests to everyone.
    await db
      .update(project)
      .set({ participantOnly: true, mcpEnabled: true })
      .where(eq(project.id, projectId));
    await record({ projectId });
  }
  return saved as Ready;
}

// Members who may use the app but are not in the project yet.
async function membersToEnrol(desk: Ready, systemUserId: string): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .leftJoin(aiAgent, eq(aiAgent.userId, user.id))
    .leftJoin(
      projectMember,
      and(eq(projectMember.userId, user.id), eq(projectMember.projectId, desk.projectId)),
    )
    .where(
      and(
        or(isNull(user.active), ne(user.active, false)),
        isNull(aiAgent.id),
        ne(user.id, systemUserId),
        isNull(projectMember.userId),
      ),
    );
  const ids = rows.map((row) => row.id);
  if (!managedAccess()) return ids;
  const allowed = await Promise.all(ids.map((id) => hasApplicationAccess(id)));
  return ids.filter((_, i) => allowed[i]);
}

// Run by a background loop. Does nothing until enabled; then creates the desk and
// enrols each member who is missing, on their own, so one failure holds back nobody
// else and the next run retries it. A member who leaves the project is enrolled again.
export async function provisionRequestDesk(): Promise<void> {
  if (!(await requestDesk()).enabled) return;
  const { systemUserId } = await personalWorkspace();
  if (!systemUserId) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK})`);
    if (!(await requestDesk()).enabled) return;
    const desk = await ensureDesk(systemUserId);
    for (const userId of await membersToEnrol(desk, systemUserId)) {
      await db
        .transaction(async (inner) => {
          await inner
            .insert(teamMember)
            .values({ teamId: desk.teamId, userId, role: 'member' })
            .onConflictDoNothing();
          await inner
            .insert(projectMember)
            .values({ projectId: desk.projectId, userId, role: 'member', roleId: desk.roleId })
            .onConflictDoNothing();
        })
        .catch((error) => console.error('[frnd-requests] enrolment failed for a member', error));
    }
  });
}
