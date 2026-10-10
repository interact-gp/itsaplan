import { aiAgent, db, issueWatcher, user, userPreference } from '@repo/db';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { getMemberContext, type MemberContext } from '#modules/members/service';
import { hasPermission } from '#shared/permissions';

// Who follows an issue. A watcher receives every notification the issue produces
// (see modules/notifications/service.ts); the assignment and mention notifications are
// addressed to one person and reach them whether they watch the issue or not.
//
// A member subscribes either by hand or through the auto-subscribe rules below.
// Unsubscribing keeps the row with subscribed = false, which is what makes it
// stick: the rules insert and never update, so the member's own next comment
// cannot put them back.

export interface IssueWatcherRow {
  userId: string;
  name: string;
  image: string | null;
}

function canReadWorkItems(context: MemberContext | null | undefined): boolean {
  return Boolean(
    context &&
    (context.role === 'owner' || hasPermission(context.permissions, 'work_items', 'read')),
  );
}

// Subscription rows survive loss of access; only currently authorized people are returned.
export async function listIssueWatchers(
  projectId: number,
  issueId: number,
): Promise<IssueWatcherRow[]> {
  const rows = await db
    .select({ userId: issueWatcher.userId, name: user.name, image: user.image })
    .from(issueWatcher)
    .innerJoin(user, eq(user.id, issueWatcher.userId))
    .leftJoin(aiAgent, eq(aiAgent.userId, issueWatcher.userId))
    .where(
      and(
        eq(issueWatcher.issueId, issueId),
        eq(issueWatcher.subscribed, true),
        isNull(aiAgent.id),
        eq(user.active, true),
      ),
    )
    .orderBy(asc(user.name));
  const eligible = await Promise.all(
    rows.map(async (row) => canReadWorkItems(await getMemberContext(projectId, row.userId))),
  );
  return rows.filter((_, index) => eligible[index]);
}

export async function watcherUserIds(projectId: number, issueId: number): Promise<Set<string>> {
  const rows = await listIssueWatchers(projectId, issueId);
  return new Set(rows.map((r) => r.userId));
}

// Watchers receive human notifications, so agent identities are excluded.
export async function isEligibleIssueWatcher(projectId: number, userId: string): Promise<boolean> {
  const [person] = await db
    .select({ id: user.id })
    .from(user)
    .leftJoin(aiAgent, eq(aiAgent.userId, user.id))
    .where(and(eq(user.id, userId), eq(user.active, true), isNull(aiAgent.id)));
  return !!person && canReadWorkItems(await getMemberContext(projectId, userId));
}

// Subscribes or unsubscribes one member by hand. Both states are stored, so an
// unsubscription survives the auto-subscribe rules.
export async function setIssueWatching(
  issueId: number,
  userId: string,
  subscribed: boolean,
): Promise<void> {
  await db
    .insert(issueWatcher)
    .values({ issueId, userId, subscribed })
    .onConflictDoUpdate({
      target: [issueWatcher.issueId, issueWatcher.userId],
      set: { subscribed },
    });
}

// Existing subscriptions are never overwritten, so an explicit unsubscribe survives later activity.
export async function autoWatchIssue(
  projectId: number,
  issueId: number,
  userIds: (string | null | undefined)[],
): Promise<void> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  const rows = await db
    .select({ userId: user.id })
    .from(user)
    .leftJoin(userPreference, eq(userPreference.userId, user.id))
    .leftJoin(aiAgent, eq(aiAgent.userId, user.id))
    .where(
      and(
        inArray(user.id, ids),
        eq(user.active, true),
        isNull(aiAgent.id),
        // No preference row yet means the default, which is on.
        or(isNull(userPreference.autoWatch), eq(userPreference.autoWatch, true)),
      ),
    );
  if (rows.length === 0) return;
  const allowed = await Promise.all(
    rows.map(async (row) => canReadWorkItems(await getMemberContext(projectId, row.userId))),
  );
  const eligible = rows.filter((_, index) => allowed[index]);
  if (eligible.length === 0) return;
  await db
    .insert(issueWatcher)
    .values(eligible.map((r) => ({ issueId, userId: r.userId })))
    .onConflictDoNothing();
}
