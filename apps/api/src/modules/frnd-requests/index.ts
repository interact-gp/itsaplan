import { Elysia } from 'elysia';
import { requireGod } from '#shared/access';
import { authContext } from '#shared/auth-context';
import { commonErrors, errors } from '#shared/responses';
import { requestDesk } from './desk';
import { RequestDeskBody, RequestDeskResponse } from './model';
import { setRequestDeskEnabled } from './service';

// Instance administration of FRND Requests: whether every member is enrolled in the
// General Requests project. Off until the participant privacy has been checked.
export const requestDeskRoutes = new Elysia({
  name: 'frnd-requests',
  detail: { tags: ['God'] },
})
  .use(authContext)
  .onBeforeHandle(async ({ user }) => {
    await requireGod(user);
  })
  .get(
    '/god/frnd-requests',
    async () => {
      const desk = await requestDesk();
      return { enabled: desk.enabled ?? false, projectId: desk.projectId ?? null };
    },
    {
      response: { 200: RequestDeskResponse, ...errors(401, 403) },
      detail: {
        summary: 'Get FRND Requests enrolment',
        description: 'Return whether every member is enrolled in the General Requests project.',
      },
    },
  )
  .put(
    '/god/frnd-requests',
    async ({ body }) => {
      const desk = await setRequestDeskEnabled(body.enabled);
      return { enabled: desk.enabled ?? false, projectId: desk.projectId ?? null };
    },
    {
      body: RequestDeskBody,
      response: { 200: RequestDeskResponse, ...commonErrors },
      detail: {
        summary: 'Turn FRND Requests enrolment on or off',
        description:
          'Turn on to create the General Requests project and enrol every member who may use the app.',
      },
    },
  );
