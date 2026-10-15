import { t } from 'elysia';

export const ReminderSettingsBody = t.Object({
  enabled: t.Boolean(),
  cron: t.String({ maxLength: 100 }),
  timezone: t.String({ minLength: 1, maxLength: 64 }),
});

export const ReminderSettingsResponse = t.Object({
  enabled: t.Boolean(),
  cron: t.String(),
  timezone: t.String(),
  nextRunAt: t.Nullable(t.String()),
  slackConfigured: t.Boolean(),
});

export const ReminderTestResponse = t.Object({
  status: t.String(),
  outcome: t.String(),
});
