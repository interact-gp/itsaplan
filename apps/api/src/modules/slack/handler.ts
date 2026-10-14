import { getMcpApp } from '#mcp/app-ref';
import { authorizedTools } from '#mcp/catalogue';
import { dispatchTool } from '#mcp/dispatch';
import { routeTools, type McpRouteTool } from '#mcp/generate';
import { activeUser } from '#shared/auth-context';
import { getMembership } from '#modules/members/service';
import { getProjectByKey, listProjects } from '#modules/projects/service';
import { escapeSlack, postDirect, postInThread, postPrivately } from './client';
import {
  asksForProject,
  bareAnswer,
  interpret,
  issueTitle,
  plainRequest,
  type ProjectOption,
} from './interpret';
import {
  defaultColumnId,
  failSlackEvent,
  finishSlackEvent,
  resolveSlackUser,
  claimPendingRequest,
  findPendingRequest,
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
      console.error('[slack]', err);
      await failSlackEvent(mention.eventId).catch(() => {});
    })
    .finally(() => running.delete(work));
  running.add(work);
}

// Resolves once every event accepted so far has been handled. For tests.
export async function slackWorkSettled() {
  await Promise.all(running);
}

function link(url: string | undefined, label: string) {
  return url ? `<${url}|${label}>` : label;
}

function appUrl(path: string) {
  return process.env.APP_URL ? `${process.env.APP_URL}${path}` : undefined;
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

async function usable(userId: string) {
  try {
    return Boolean(await activeUser(userId));
  } catch {
    return false;
  }
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
  // A project the sender did not name may be one the channel cannot see, so only the
  // sender is told where the task went.
  const announce = intent.named
    ? (message: string) => postInThread(channelId, threadTs, message)
    : tell;
  await createIssue(
    mention,
    userId,
    request,
    tool,
    intent.project,
    botUserId,
    finish,
    tell,
    announce,
  );
}

async function createIssue(
  mention: SlackMention,
  userId: string,
  request: string,
  tool: McpRouteTool,
  target: ProjectOption,
  botUserId: string | undefined,
  finish: (status: SlackEventStatus, extra?: Outcome) => Promise<void>,
  tell: (text: string) => Promise<void>,
  announce: (text: string) => Promise<void>,
) {
  const project = await getProjectByKey(target.key);
  const columnId = project ? await defaultColumnId(project.id) : null;
  if (!project || !columnId) {
    await finish('failed');
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
    const id = await resolveSlackUser(mention.slackTeamId, assigneeSlackId);
    if (!id || !(await usable(id)) || !(await getMembership(project.id, id))) {
      await finish('refused');
      await tell(
        `<@${assigneeSlackId}> is not a member of ${target.key}, so I did not create the task. A project admin has to add them first.`,
      );
      return;
    }
    assigneeUserId = id;
  }

  const title = await issueTitle(request);
  const result = await dispatchTool(
    getMcpApp(),
    tool,
    {
      projectKey: target.key,
      columnId,
      title,
      description: `Created from a Slack request:\n\n> ${plainRequest(request)}`,
      ...(assigneeUserId ? { assigneeUserId } : {}),
    },
    { kind: 'user', userId },
    { viaMcpEndpoint: true },
  );
  if (result.isError) {
    await finish('failed');
    await tell(`I could not create the task: ${routeError(result.text)}.`);
    return;
  }
  const issue = JSON.parse(result.text) as {
    id: number;
    identifier: string;
    sequenceNumber: number;
    title: string;
  };
  await finish('done', { issueId: issue.id, projectId: project.id });
  const label = link(
    appUrl(`/project/${target.key}/issue/${issue.sequenceNumber}`),
    issue.identifier,
  );
  const shown = escapeSlack(issue.title);
  await announce(`Created ${label}: ${shown}`);
  if (assigneeSlackId && assigneeSlackId !== mention.slackUserId)
    await postDirect(
      assigneeSlackId,
      `<@${mention.slackUserId}> assigned you ${label}: ${shown}`,
    ).catch((err) => console.error('[slack] assignee message failed', err));
}
