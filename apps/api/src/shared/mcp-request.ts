// Marks a request as originating from an MCP tool call. The MCP endpoint runs each
// tool as an in-process loopback request against the real route (see
// mcp/dispatch.ts); it sets this header so access guards can tell an MCP call from
// a normal web/API call and enforce the per-project MCP toggle only on the former.
// A direct caller could forge the header, but doing so only makes the guard treat
// the request as MCP and thus deny MCP-disabled projects — it can add the
// restriction, never remove it, so it is safe to trust.
export const MCP_LOOPBACK_HEADER = 'x-mcp-loopback';

const oauthTokens = new WeakMap<Request, string>();
// A user id attached by in-process code that authenticated the user itself (the
// Slack bot). Only code that builds the Request can set it, so it cannot arrive over
// the network.
const actingUsers = new WeakMap<Request, string>();

// True when the request came from an MCP tool dispatch.
export function isMcpRequest(headers: Headers): boolean {
  return headers.get(MCP_LOOPBACK_HEADER) === '1';
}

export function setMcpOAuthToken(request: Request, token: string): void {
  oauthTokens.set(request, token);
}

export function getMcpOAuthToken(request: Request): string | undefined {
  return oauthTokens.get(request);
}

export function setActingUser(request: Request, userId: string): void {
  actingUsers.set(request, userId);
}

export function getActingUser(request: Request): string | undefined {
  return actingUsers.get(request);
}
