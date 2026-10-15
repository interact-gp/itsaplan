import { createHmac, timingSafeEqual } from 'node:crypto';

// Slack signs `v0:<timestamp>:<raw body>` with the app's signing secret. A request
// older than five minutes is refused so a captured one cannot be replayed later.
const MAX_AGE_SECONDS = 5 * 60;

export function slackSignatureValid(
  secret: string,
  rawBody: string,
  headers: Record<string, string | undefined>,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const timestamp = Number(headers['x-slack-request-timestamp']);
  const signature = headers['x-slack-signature'];
  if (!Number.isInteger(timestamp) || !signature?.startsWith('v0=')) return false;
  if (Math.abs(nowSeconds - timestamp) > MAX_AGE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest();
  const given = Buffer.from(signature.slice(3), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
