import { t } from 'elysia';

// The raw body, kept as text so the signature is checked over the exact bytes Slack
// signed.
export const slackEventBody = t.String();

export const SlackEventResponse = t.Union([
  t.Object({ challenge: t.String() }),
  t.Object({ ok: t.Boolean() }),
]);
