import { Elysia } from 'elysia';
import { db, managedAccess, hasApplicationAccess } from '@repo/db';
import { user as users } from '@repo/db/schema';
import { eq } from 'drizzle-orm';
import { auth, getSessionFromHeaders } from '@repo/auth';
import { HttpError } from './lib';
import { getActingUser, getMcpOAuthToken } from './mcp-request';

// GET routes that need no session. The raw attachment and avatar bytes routes
// must work in <img>/<video> and external fetches. The invite lookup
// (`GET /invites/:token`) renders the accept screen for a logged-out invitee, who
// signs up from there; only accept/reject (POST) require a session. Every `/share/`
// GET renders a public read-only shared issue or view, keyed by an unguessable
// token. All ids are unguessable.
const PUBLIC_GET =
  /^\/attachments\/[^/]+\/raw$|^\/chat-attachments\/[^/]+\/raw$|^\/initiative-attachments\/[^/]+\/raw$|^\/avatars\/[^/]+\/raw$|^\/invites\/[^/]+$|^\/share\//;

type SessionResult = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

// The authenticated user carried on the request context.
export type SessionUser = SessionResult['user'];

// Session plugin shared by the planner. Resolves the better-auth session once and
// puts `user` on the context, so handlers and the access guards read it instead
// of calling getSession again. A missing session is a 401, except on the public
// raw-attachment route, which carries no user.
//
// planner.ts uses this as the runtime backstop, so every planner route is
// session-gated. A feature also uses it directly when its handlers or local
// macros reference `user`, which is what makes the `user` type flow there. The
// plugin is named, so its resolve runs once per request (dedup).
//
// A deactivated account is refused here rather than at sign-in: deactivation
// arrives over SCIM while sessions and API keys are already open, and this is the
// one place every planner route and the MCP surface pass through.
export const authContext = new Elysia({ name: 'auth-context' }).resolve(
  { as: 'scoped' },
  async ({ request, path }): Promise<{ user: SessionUser | null }> => {
    const session = await getSessionFromHeaders(request.headers);
    if (session) {
      if (session.user.active === false) throw new HttpError(401, 'This account is deactivated');
      await assertOrganizationAccess(session.user);
      return { user: session.user };
    }
    const mcpToken = getMcpOAuthToken(request);
    if (mcpToken) {
      const oauthSession = await auth.api.getMcpSession({
        headers: new Headers({ Authorization: `Bearer ${mcpToken}` }),
      });
      if (oauthSession) {
        const user = await activeUser(oauthSession.userId);
        if (user) return { user };
      }
    }
    const actingUserId = getActingUser(request);
    if (actingUserId) {
      const user = await activeUser(actingUserId);
      if (user) return { user };
    }
    // The public raw-attachment route has no session and needs none.
    if (request.method === 'GET' && PUBLIC_GET.test(path)) return { user: null };
    throw new HttpError(401, 'Authentication required');
  },
);

// The account behind userId when it may use the app, undefined when it does not exist;
// throws 401 or 403 when it is deactivated or has no application access.
export async function activeUser(userId: string): Promise<SessionUser | undefined> {
  const user = await db.query.user.findFirst({ where: eq(users.id, userId) });
  if (!user) return undefined;
  if (user.active === false) throw new HttpError(401, 'This account is deactivated');
  await assertOrganizationAccess(user);
  return user as SessionUser;
}

async function assertOrganizationAccess(user: { id: string; role?: string | null }) {
  if (managedAccess() && user.role !== 'god' && !(await hasApplicationAccess(user.id))) {
    throw new HttpError(403, 'Application access has not been granted');
  }
}
