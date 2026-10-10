import { and, eq, inArray } from 'drizzle-orm';
import { db } from './client';
import { scimGroup, scimGroupMember } from './schema/scim';
import { aiAgent } from './schema/app';
import { user } from './schema/auth';
import { getSetting } from './settings';

export const managedAccess = () => process.env.ITSAPLAN_MANAGED_ACCESS === 'true';
export const organizationGroups = {
  admin: '/access/frnd-prd/admin',
  member: '/access/frnd-prd/member',
};

export async function organizationAccess(userId: string) {
  const groups = await db
    .select({ name: scimGroup.displayName })
    .from(scimGroupMember)
    .innerJoin(scimGroup, eq(scimGroup.id, scimGroupMember.groupId))
    .where(
      and(
        eq(scimGroupMember.userId, userId),
        inArray(scimGroup.displayName, Object.values(organizationGroups)),
      ),
    );
  const lastSync = (await getSetting<number>('organization.lastSync')) ?? 0;
  const age = Date.now() - lastSync;
  const fresh = Number.isFinite(age) && age >= 0 && age < 120_000;
  return {
    enabled: fresh && groups.length > 0,
    admin: fresh && groups.some((g) => g.name === organizationGroups.admin),
  };
}

export async function hasApplicationAccess(userId: string) {
  const [agent] = await db
    .select({ active: user.active })
    .from(aiAgent)
    .innerJoin(user, eq(user.id, aiAgent.userId))
    .where(eq(aiAgent.userId, userId));
  if (agent) return agent.active !== false;

  return (await organizationAccess(userId)).enabled;
}
