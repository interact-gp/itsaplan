import { and, eq } from 'drizzle-orm';
import {
  isOrganizationAdmin,
  db,
  organizationAccess,
  team,
  teamMember,
  teamRole,
  user,
} from '@repo/db';
import { HttpError } from '#shared/lib';
import { assertTeamSeatFree } from './service';

export async function addManagedTeamMember(
  teamId: number,
  actorId: string,
  input: { email: string; role: 'owner' | 'manager' | 'member'; roleId?: number | null },
) {
  return db.transaction(async (tx) => {
    await tx.select({ id: team.id }).from(team).where(eq(team.id, teamId)).for('update');
    const [actor] = await tx
      .select({ role: teamMember.role })
      .from(teamMember)
      .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, actorId)));
    const actorRole = (await isOrganizationAdmin(actorId)) ? 'owner' : actor?.role;
    if (actorRole !== 'owner' && actorRole !== 'manager')
      throw new HttpError(403, 'Only a team owner or manager can add members');
    if (input.role !== 'member' && actorRole !== 'owner')
      throw new HttpError(403, 'Only a team owner can grant administrative team roles');
    const [person] = await tx.select().from(user).where(eq(user.email, input.email.toLowerCase()));
    if (!person || person.active === false || !(await organizationAccess(person.id)).enabled)
      throw new HttpError(400, 'The person needs application access first');
    if (input.roleId != null) {
      const [role] = await tx
        .select({ id: teamRole.id })
        .from(teamRole)
        .where(and(eq(teamRole.id, input.roleId), eq(teamRole.teamId, teamId)));
      if (!role || input.role !== 'member')
        throw new HttpError(400, 'A member role from this team is required');
    }
    const [existing] = await tx
      .select()
      .from(teamMember)
      .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, person.id)));
    if (existing) throw new HttpError(409, 'The person is already a team member');
    await assertTeamSeatFree(teamId);
    await tx
      .insert(teamMember)
      .values({ teamId, userId: person.id, role: input.role, roleId: input.roleId ?? null });
    return { userId: person.id };
  });
}
