import { t } from 'elysia';

export const PersonalPageResponse = t.Object({
  projectKey: t.String(),
  documentId: t.Number(),
});
