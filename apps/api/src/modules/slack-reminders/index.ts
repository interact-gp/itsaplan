import { Elysia } from 'elysia';
import { requireGod, requireUser } from '#shared/access';
import { authContext } from '#shared/auth-context';
import { commonErrors, errors } from '#shared/responses';
import { ReminderSettingsBody, ReminderSettingsResponse, ReminderTestResponse } from './model';
import { getReminderSettings, sendTestReminder, updateReminderSettings } from './service';

const slackConfigured = () => Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_TEAM_ID);

// Instance administration of the Slack pending-work digest: its schedule and a test
// that sends the digest to the calling administrator only.
export const slackReminderRoutes = new Elysia({
  name: 'slack-reminders',
  detail: { tags: ['God'] },
})
  .use(authContext)
  .onBeforeHandle(async ({ user }) => {
    await requireGod(user);
  })
  .get(
    '/god/slack-reminders',
    async () => ({ ...(await getReminderSettings()), slackConfigured: slackConfigured() }),
    {
      response: { 200: ReminderSettingsResponse, ...errors(401, 403) },
      detail: {
        summary: 'Get the Slack reminder schedule',
        description: 'Return whether the Slack digest of pending work runs, and when.',
      },
    },
  )
  .put(
    '/god/slack-reminders',
    async ({ body }) => ({
      ...(await updateReminderSettings(body)),
      slackConfigured: slackConfigured(),
    }),
    {
      body: ReminderSettingsBody,
      response: { 200: ReminderSettingsResponse, ...commonErrors },
      detail: {
        summary: 'Set the Slack reminder schedule',
        description:
          'Turn the Slack digest of pending work on or off and set its cron schedule and timezone.',
      },
    },
  )
  .post('/god/slack-reminders/test', async ({ user }) => sendTestReminder(requireUser(user).id), {
    response: { 200: ReminderTestResponse, ...errors(401, 403) },
    detail: {
      summary: 'Send a test Slack reminder',
      description: 'Send your own pending-work digest to your own Slack DM now.',
    },
  });
