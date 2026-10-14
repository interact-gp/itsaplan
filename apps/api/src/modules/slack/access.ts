import { activeUser } from '#shared/auth-context';
import { getMemberContext } from '#modules/members/service';
import { hasPermission } from '#shared/permissions';

// Whether the account may use the app now: it exists, is active and has application
// access.
export async function usable(userId: string): Promise<boolean> {
  try {
    return Boolean(await activeUser(userId));
  } catch {
    return false;
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
