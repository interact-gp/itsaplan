// The few Slack Web API calls the bot makes, authenticated with the bot token.
// Form-encoded because some read methods (users.info) do not accept a JSON body.

export interface SlackProfile {
  email?: string;
  deleted?: boolean;
  isBot?: boolean;
  teamId?: string;
}

// Slack reads `<…>` as a mention, a broadcast (<!channel>) or a link, and `&` as the
// start of an entity. Text a user or a model wrote goes through this before it is
// posted, so it is shown as written and cannot ping or disguise a link.
export function escapeSlack(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function call(method: string, args: Record<string, string>) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(args),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body?.ok)
    throw new Error(`Slack ${method} failed: ${String(body?.error ?? response.status)}`);
  return body;
}

export async function slackProfile(slackUserId: string): Promise<SlackProfile> {
  const body = await call('users.info', { user: slackUserId });
  const user = body.user as {
    deleted?: boolean;
    is_bot?: boolean;
    team_id?: string;
    profile?: { email?: string };
  };
  return {
    email: user.profile?.email,
    deleted: user.deleted,
    isBot: user.is_bot,
    teamId: user.team_id,
  };
}

// A reply in the thread, visible to everyone in the channel.
export async function postInThread(channel: string, threadTs: string, text: string) {
  await call('chat.postMessage', { channel, thread_ts: threadTs, text });
}

// A message only `slackUserId` sees, in the thread when one is given. Used for anything
// that names projects or people the rest of the channel may not be allowed to see.
export async function postPrivately(
  channel: string,
  threadTs: string | undefined,
  slackUserId: string,
  text: string,
) {
  await call('chat.postEphemeral', {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    user: slackUserId,
    text,
  });
}

export async function postDirect(slackUserId: string, text: string) {
  await call('chat.postMessage', { channel: slackUserId, text });
}
