import { getMcpApp } from '#mcp/app-ref';
import { authorizedTools } from '#mcp/catalogue';
import { dispatchTool } from '#mcp/dispatch';
import { routeTools, type McpRouteTool } from '#mcp/generate';
import { getProjectByKey, listProjects } from '#modules/projects/service';
import { escapeSlack, postPrivately } from './client';
import { canReadIssues, usable } from './access';
import { queueBotMessages, sendBotMessages } from './messages';
import {
  asksForProject,
  bareAnswer,
  interpret,
  issueTitle,
  plainRequest,
  type ProjectOption,
} from './interpret';
import {
  claimPendingRequest,
  claimRetry,
  defaultColumnId,
  failSlackEvent,
  findPendingRequest,
  finishSlackEvent,
  planIssue,
  plannedIssueId,
  resolveSlackUser,
  saveRequest,
  type SlackEventStatus,
  type SlackMention,
} from './service';

// The only thing the bot does: add a task to an existing project.
const ACTION = 'create_issue';
const MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

interface Outcome {
  issueId?: number;
  projectId?: number;
}

const running = new Set<Promise<void>>();

// Slack expects the event acknowledged within three seconds, so the work runs after
// the response. A failure is logged and recorded on the event, never thrown.
export function handleInBackground(mention: SlackMention, botUserId: string | undefined) {
  const work: Promise<void> = handleMention(mention, botUserId)
    .catch(async (err) => {
      console.error(`[slack] event ${mention.eventId} failed: ${errorCode(err)}`);
      await failSlackEvent(mention.eventId).catch(() => {});
    })
    .finally(() => running.delete(work));
  running.add(work);
}

// Resolves once every event accepted so far has been handled. For tests.
export async function slackWorkSettled() {
  await Promise.all(running);
}

const RETRY_BATCH = 10;

// Run by a background loop: works again on events that failed or were interrupted,
// from the request stored with them, then sends the replies still owed.
export async function retrySlackWork(): Promise<void> {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_TEAM_ID) return;
  for (let i = 0; i < RETRY_BATCH; i++) {
    const row = await claimRetry();
    if (!row) break;
    const mention: SlackMention = {
      eventId: row.eventId,
      slackTeamId: row.slackTeamId,
      channelId: row.channelId,
      messageTs: row.messageTs,
      threadTs: row.threadTs,
      slackUserId: row.slackUserId,
      text: row.request,
    };
    await handleMention(mention, row.botUserId ?? undefined).catch(async (err) => {
      console.error(`[slack] event ${row.eventId} failed: ${errorCode(err)}`);
      await failSlackEvent(row.eventId);
    });
  }
  await sendBotMessages();
}

// A database error carries its query parameters, which hold the message text and email
// addresses, so only its code is logged.
function errorCode(err: unknown) {
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (typeof cause?.code === 'string') return cause.code;
  return err instanceof Error ? err.name : 'error';
}

function routeError(text: string) {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string') return escapeSlack(body.error);
  } catch {
    // not JSON
  }
  return 'the request was refused';
}

async function creatableProjects(userId: string): Promise<ProjectOption[]> {
  const projects = await listProjects(userId, { mcpOnly: true, withPermissions: true });
  return projects
    .filter((p) => p.role === 'owner' || p.permissions?.work_items.create)
    .map((p) => ({ key: p.key, name: p.name, teamName: p.teamName }));
}

export async function handleMention(mention: SlackMention, botUserId: string | undefined) {
  const { channelId, threadTs, slackUserId } = mention;
  // Slack hides a private message in a thread that has no other replies, so an answer to
  // a message posted in the channel itself goes to the channel.
  const inThread = threadTs !== mention.messageTs;
  const privateThread = inThread ? threadTs : undefined;
  const tell = (text: string) => postPrivately(channelId, privateThread, slackUserId, text);

  const userId = await resolveSlackUser(mention.slackTeamId, slackUserId);
  if (!userId || !(await usable(userId))) {
    await finishSlackEvent(mention.eventId, { status: 'refused', userId: userId ?? undefined });
    await tell(
      userId
        ? 'Your Itsaplan account cannot use the app right now, so I did not do anything.'
        : 'I could not match your Slack account to an Itsaplan account. The email on your Slack profile has to be the verified email of your Itsaplan account.',
    );
    return;
  }

  const text = mention.text.replaceAll(`<@${botUserId}>`, '').trim();
  let request = text;
  const finish = (status: SlackEventStatus, extra: Outcome = {}) =>
    finishSlackEvent(mention.eventId, { status, userId, request, ...extra });
  if (!text) {
    await finish('refused');
    await tell(
      'Write the request after mentioning me, for example "create a task in PROJECT to …".',
    );
    return;
  }

  const [tool] = await authorizedTools(
    routeTools(getMcpApp()).filter((t) => t.name === ACTION),
    userId,
  );
  if (!tool) {
    await finish('refused');
    await tell(
      'You cannot add tasks through me: none of your projects allow it with AI access (MCP) turned on.',
    );
    return;
  }
  const projects = await creatableProjects(userId);

  const pending = await findPendingRequest(mention);
  if (pending && (inThread || bareAnswer(text, projects))) {
    if (!(await claimPendingRequest(pending.eventId))) {
      await finish('refused');
      return;
    }
    request = `${pending.request}\n${text}`;
    await saveRequest(mention.eventId, request);
  } else if (bareAnswer(text, projects)) {
    // Only a project name, with no question waiting for it (or another answer took
    // it first): there is no task to create.
    await finish('refused');
    await tell(
      'No request is waiting for a project. Write the whole request, for example "create a task in PROJECT to …".',
    );
    return;
  }

  if (asksForProject(request)) {
    await finish('refused');
    await tell('I can only add tasks to existing projects ("create a task in PROJECT to …").');
    return;
  }

  const intent = await interpret(request, projects);
  if (!intent.project) {
    await finish('clarify');
    await tell(
      projects.length
        ? `Which project should the task go in? Mention me again with one of: ${projects.map((p) => `${p.key} (${escapeSlack(p.name)})`).join(', ')}.`
        : 'There is no project where you can create tasks through me.',
    );
    return;
  }
  await createIssue(
    mention,
    userId,
    request,
    tool,
    intent.project,
    intent.named,
    botUserId,
    finish,
    tell,
  );
}

async function createIssue(
  mention: SlackMention,
  userId: string,
  request: string,
  tool: McpRouteTool,
  target: ProjectOption,
  named: boolean,
  botUserId: string | undefined,
  finish: (status: SlackEventStatus, extra?: Outcome) => Promise<void>,
  tell: (text: string) => Promise<void>,
) {
  const project = await getProjectByKey(target.key);
  const columnId = project ? await defaultColumnId(project.id) : null;
  if (!project || !columnId) {
    await finish('refused');
    await tell(`I could not create the task: ${target.key} has no board column.`);
    return;
  }

  const tagged = [
    ...new Set([...request.matchAll(MENTION)].map((m) => m[1]!).filter((id) => id !== botUserId)),
  ];
  if (tagged.length > 1) {
    await finish('refused');
    await tell('A task has one assignee. Mention me again with only one person tagged.');
    return;
  }
  const assigneeSlackId = tagged[0];
  let assigneeUserId: string | undefined;
  if (assigneeSlackId) {
    // The assignee is sent the task's title, so they must be able to read the
    // project's tasks, not only belong to it.
    const id = await resolveSlackUser(mention.slackTeamId, assigneeSlackId);
    if (!id || !(await canReadIssues(project.id, id))) {
      await finish('refused');
      await tell(
        `<@${assigneeSlackId}> is not a member of ${target.key} who can see its tasks, so I did not create the task. A project admin has to give them access first.`,
      );
      return;
    }
    assigneeUserId = id;
  }

  // A retry after an interruption finds the task the first run made, by the
  // description recorded just before it was created, instead of making another.
  const description = `Created from a Slack request:\n\n> ${plainRequest(request)}`;
  let issueId = await plannedIssueId(mention.eventId);
  if (issueId === null) {
    await planIssue(mention.eventId, project.id, description);
    const title = await issueTitle(request);
    const result = await dispatchTool(
      getMcpApp(),
      tool,
      {
        projectKey: target.key,
        columnId,
        title,
        description,
        ...(assigneeUserId ? { assigneeUserId } : {}),
      },
      { kind: 'user', userId },
      { viaMcpEndpoint: true },
    );
    if (result.isError) {
      await finish('refused');
      await tell(`I could not create the task: ${routeError(result.text)}.`);
      return;
    }
    issueId = (JSON.parse(result.text) as { id: number }).id;
  }
  await finish('done', { issueId, projectId: project.id });

  // The confirmation and the assignee's message are sent apart and retried apart.
  // A project the sender did not name may be one the channel cannot see, so then only
  // the sender is told where the task went.
  await queueBotMessages([
    {
      eventId: mention.eventId,
      kind: named ? 'thread_reply' : 'private_reply',
      issueId,
      slackUserId: mention.slackUserId,
    },
    ...(assigneeSlackId && assigneeUserId && assigneeSlackId !== mention.slackUserId
      ? [
          {
            eventId: mention.eventId,
            kind: 'assignee' as const,
            issueId,
            slackUserId: assigneeSlackId,
            userId: assigneeUserId,
          },
        ]
      : []),
  ]);
  await sendBotMessages(mention.eventId);
}
