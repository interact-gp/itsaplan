import { Elysia } from 'elysia';
import { HttpError } from '#shared/lib';
import { errors } from '#shared/responses';
import { handleInBackground } from './handler';
import { SlackEventResponse, slackEventBody } from './model';
import { claimSlackEvent } from './service';
import { slackSignatureValid } from './verify';

interface SlackPayload {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  authorizations?: { user_id?: string }[];
  event?: {
    type?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    channel?: string;
  };
}

// Slack Events API receiver. Mounted on the root app: a delivery carries no session,
// and the app's signing secret is its authentication. Only @mentions from the
// configured workspace are acted on.
export const slackRoutes = new Elysia({ name: 'slack', detail: { tags: ['Slack'] } }).post(
  '/slack/events',
  async ({ body, headers }) => {
    const secret = process.env.SLACK_SIGNING_SECRET;
    const workspace = process.env.SLACK_TEAM_ID;
    if (!secret || !workspace || !process.env.SLACK_BOT_TOKEN)
      throw new HttpError(404, 'Slack is not configured');
    if (!slackSignatureValid(secret, body, headers)) throw new HttpError(401, 'Invalid signature');

    let payload: SlackPayload;
    try {
      payload = JSON.parse(body) as SlackPayload;
    } catch {
      throw new HttpError(400, 'Invalid JSON payload');
    }
    if (payload.type === 'url_verification') return { challenge: String(payload.challenge ?? '') };

    const event = payload.event;
    if (
      payload.type !== 'event_callback' ||
      payload.team_id !== workspace ||
      !payload.event_id ||
      event?.type !== 'app_mention' ||
      event.bot_id ||
      !event.user ||
      !event.channel ||
      !event.ts
    )
      return { ok: true };

    const mention = {
      eventId: payload.event_id,
      slackTeamId: workspace,
      channelId: event.channel,
      messageTs: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      slackUserId: event.user,
      text: event.text ?? '',
    };
    if (await claimSlackEvent(mention))
      handleInBackground(mention, payload.authorizations?.[0]?.user_id);
    return { ok: true };
  },
  {
    parse: 'text',
    body: slackEventBody,
    response: { 200: SlackEventResponse, ...errors(400, 401, 404) },
    detail: {
      summary: 'Receive a Slack event',
      description:
        'Receive Slack Events API deliveries, verify them against the Slack signing secret, and ' +
        'create the task or project an @mention asks for, as the Slack user who sent it.',
    },
  },
);
