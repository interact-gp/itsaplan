# Slack bot

People in the instance Slack workspace mention the bot in a channel it was invited to,
and it adds a task to an existing project as them:

```
@Itsaplan create a task in MKT to fix push notifications and assign @Ayush
```

Adding tasks is the only thing it does. It does not create projects or teams, and it
performs no administration: it never adds anyone to a team or project or changes a
setting. It acts with the sender's own access, so it can do nothing the sender could not
do in the web app over MCP.

## How a mention is handled

1. `POST /slack/events` checks the Slack signature and refuses a request older than five
   minutes. Only events from `SLACK_TEAM_ID` are acted on. The event is stored with its
   whole message before Slack is answered, so a retried delivery creates nothing a second
   time, and work that failed (a Slack lookup error) or was interrupted is picked up again
   by a background loop or a redelivery, up to five attempts. Just before the task is
   created its description is recorded, so a retry after an interruption finds that task
   instead of creating another.
2. The sender is matched to an account by the email on their Slack profile, which must
   be the verified email of an active account with application access. The match is
   stored in `user_slack_account`. An email written in a message is never used.
3. A request for a new project is refused. Otherwise Jev chooses the project, only among
   the ones the sender may add tasks to with MCP turned on. A project key written in
   capitals is taken directly, and so is a project name that follows "in" ("in Growth")
   or is the whole answer to the bot's question. A name used as an ordinary word
   elsewhere in the message is left to Jev. When the project is unclear, the bot asks
   privately to the sender. The
   next mention in the thread of the request completes it. So does a mention in the
   channel within ten minutes that is only a project key or name ("@Itsaplan OPS"); a
   longer message there is a new request. The question is posted in the channel when the
   request was, because Slack does not show a private message in a thread that has no
   other replies. Two answers handled at the same time complete the request once.
4. The task is created through the same route the web app and MCP use, as the
   sender, so the route checks the account, the permission and the MCP switch again.
5. A tagged assignee must be able to use the app and read the project's tasks (a role
   can deny that to a member), or nothing is created.
6. The bot replies with the link and sends the assignee a direct message. The two are
   queued in `slack_bot_message` and sent and retried apart, so one failing does not
   stop the other. The assignee's access is checked again right before their message is
   sent. The reply is in the thread when the message named the project, and visible only
   to the sender when Jev chose it. Questions and refusals are always visible only to the sender, since
   they can name projects other people in the channel cannot see.

The task title is written by `anthropic/claude-haiku-5.5` through OpenRouter, with the
same `OPENROUTER_API_KEY` as Jev. Without the key, the bot still creates tasks: it takes a
project only when the message names it as described in step 3, and the title is the
message text.

Text from a message or a model is escaped before the bot posts it, so it cannot ping a
channel or show a disguised link.

## Setting it up

1. At <https://api.slack.com/apps>, choose **Create New App → From an app manifest**,
   pick the workspace, and paste the manifest below with the api origin in `request_url`.
2. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`) and, from
   **Basic Information**, the **Signing Secret**.
3. Set on the api and restart it:

   ```
   SLACK_SIGNING_SECRET=<signing secret>
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_TEAM_ID=<workspace id, starts with T>
   ```

   The workspace id is in the workspace URL in the browser (`app.slack.com/client/T…`).
4. In **Event Subscriptions**, retry the request URL until Slack shows it as verified.
5. Invite the bot to a channel: `/invite @Itsaplan`.

```yaml
display_information:
  name: Itsaplan
  description: Add Itsaplan tasks from Slack
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: true
  bot_user:
    display_name: Itsaplan
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    request_url: https://<api origin>/slack/events
    bot_events:
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

For local development, Slack has to reach the api on your machine, for example through
`cloudflared tunnel --url http://localhost:3000`, with the tunnel URL in `request_url`.
