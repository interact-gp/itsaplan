import { t } from 'elysia';

export const RequestDeskBody = t.Object({ enabled: t.Boolean() });

export const RequestDeskResponse = t.Object({
  enabled: t.Boolean(),
  projectId: t.Nullable(t.Number()),
});
