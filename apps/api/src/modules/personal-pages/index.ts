import { Elysia } from 'elysia';
import { mcpTool } from '#mcp/generate';
import { requireUser } from '#shared/access';
import { authContext } from '#shared/auth-context';
import { HttpError } from '#shared/lib';
import { errors } from '#shared/responses';
import { PersonalPageResponse } from './model';
import { personalPageOf } from './service';

// The session user's own "My To-do" page. Its content is read and edited through the
// document routes, which only let its owner reach it.
export const personalPageRoutes = new Elysia({
  name: 'personal-pages',
  detail: { tags: ['Documents'] },
})
  .use(authContext)
  .get(
    '/account/personal-page',
    async ({ user }) => {
      const page = await personalPageOf(requireUser(user).id);
      if (!page) throw new HttpError(404, 'Your personal page is not ready yet');
      return page;
    },
    {
      response: { 200: PersonalPageResponse, ...errors(401, 404) },
      detail: {
        summary: 'Find my personal page',
        description:
          'Return the project key and document id of your own "My To-do" page. Read and edit it with get_document and update_document.',
        ...mcpTool('get_my_todo_page'),
      },
    },
  );
