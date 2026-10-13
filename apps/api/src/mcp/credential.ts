export type McpCredential =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'oauth'; accessToken: string }
  | { kind: 'user'; userId: string };
