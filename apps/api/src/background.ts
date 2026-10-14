import { intEnv } from '#shared/lib';
import { agentRunConfig } from '#modules/agents/core/run-queue';
import { processAgentRuns } from '#modules/agents/core/run-poller';
import { sweepStaleIssues } from '#modules/issues/auto-archive';
import { syncKeycloakAccess } from '#modules/organization/keycloak';
import { retrySlackWork } from '#modules/slack/handler';
import { provisionPersonalPages } from '#modules/personal-pages/service';
import { runReminders } from '#modules/slack-reminders/service';
import { provisionRequestDesk } from '#modules/frnd-requests/service';
import { drainRequestMessages } from '#modules/frnd-requests/messages';
import { managedAccess } from '@repo/db';

// The api's background jobs, started by index.ts rather than assembled into the app,
// so importing the app in a test starts nothing. Several api replicas run them without
// overlapping: the queue is claimed with FOR UPDATE SKIP LOCKED, and the sweep only
// touches rows it has not archived yet.

// Each job gets a loop of its own. A run is an LLM call of minutes and a first sweep
// can carry thousands of issues, so sharing one loop would let either hold the other
// back for that long.
export function startBackgroundJobs(): void {
  if (managedAccess()) startLoop('organization-access', syncKeycloakAccess, () => 15_000);
  // Works again on Slack requests that failed or were interrupted, and sends the replies
  // still owed for tasks the bot created.
  startLoop('slack-bot', retrySlackWork, () => 30_000);
  // Gives each member who may use the app their "My To-do" page, including people
  // who have not signed in yet, and retries anything a previous run left undone.
  startLoop('personal-pages', provisionPersonalPages, () => 30_000);
  // Enrols every member in General Requests once an administrator has turned it on.
  startLoop('frnd-requests', provisionRequestDesk, () => 30_000);
  // Sends the private Slack messages about requests, including retries.
  startLoop('frnd-request-messages', drainRequestMessages, () => 15_000);
  // Queues the Slack digest when its schedule comes due (it is off until one is set)
  // and sends queued digests, including retries.
  startLoop('slack-reminders', runReminders, () => 60_000);
  startLoop('agent-runs', processAgentRuns, agentRunConfig.pollIntervalMs);
  // Archiving is not time-sensitive, so the sweep runs far less often than the queue
  // is drained.
  startLoop('auto-archive', autoArchive, () => intEnv('AUTO_ARCHIVE_INTERVAL_MS', 3_600_000));
}

async function autoArchive(): Promise<void> {
  const archived = await sweepStaleIssues();
  if (archived > 0) console.log(`[background] auto-archived ${archived} stale issues`);
}

function startLoop(name: string, job: () => Promise<void>, intervalMs: () => number): void {
  const tick = async () => {
    try {
      await job();
    } catch (error) {
      console.error(`[background] ${name} failed:`, error);
    }
    setTimeout(tick, intervalMs()).unref();
  };
  void tick();
}
