import { Elysia, t } from 'elysia';
import { db, managedAccess, organizationAccess, user } from '@repo/db';
import { eq } from 'drizzle-orm';
import { authContext } from '#shared/auth-context';
import { guards } from '#shared/guards';
import { HttpError } from '#shared/lib';
import { mcpTool } from '#mcp/generate';
import { errors } from '#shared/responses';
import { setApplicationAccess } from './keycloak';

export const organizationRoutes = new Elysia({ name: 'organization' })
  .use(authContext)
  .use(guards)
  .get(
    '/organization/access',
    async ({ user }) => ({
      managed: managedAccess(),
      ...(managedAccess() && user!.role !== 'god'
        ? await organizationAccess(user!.id)
        : { enabled: true, admin: true }),
    }),
    {
      detail: {
        summary: 'Get application access',
        description:
          'Read the current user’s application access and organization administrator status.',
      },
    },
  )
  .get(
    '/organization/users',
    async () => {
      if (!managedAccess()) throw new HttpError(400, 'Managed access is disabled');
      const people = await db
        .select({ id: user.id, email: user.email, name: user.name, active: user.active })
        .from(user)
        .where(eq(user.role, 'user'));
      return Promise.all(
        people.map(async (person) => ({ ...person, ...(await organizationAccess(person.id)) })),
      );
    },
    {
      organizationAdmin: true,
      detail: {
        summary: 'List application access',
        description:
          'List provisioned users and their current application access. Requires managed access and an organization administrator.',
        ...mcpTool('list_application_access'),
      },
    },
  )
  .post(
    '/organization/access',
    async ({ body, user: actor }) => {
      const [target] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, body.email.toLowerCase()));
      if (target?.id === actor!.id)
        throw new HttpError(409, 'You cannot change your own application access');
      return setApplicationAccess(body.email, body.role, actor!.id);
    },
    {
      organizationAdmin: true,
      body: t.Object({
        email: t.String({ format: 'email' }),
        role: t.UnionEnum(['admin', 'member', 'none']),
      }),
      response: {
        200: t.Object({ role: t.UnionEnum(['admin', 'member', 'none']) }),
        ...errors(400, 401, 403, 409),
      },
      detail: {
        summary: 'Set application access',
        description:
          'Grant or revoke application access for a verified company identity through Keycloak. Organization administrators cannot change their own access or remove the last administrator.',
        ...mcpTool('set_application_access', { destructiveHint: true }),
      },
    },
  );
