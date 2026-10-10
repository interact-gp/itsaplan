import { z } from 'zod';
import { HttpError } from '#shared/lib';
import { authorizedTools } from './catalogue';
import { DISCOVERY_TOOLS } from './discovery-tools';
import { rankTools } from './jev';
import { withoutFields, type McpRouteTool } from './generate';

const discoveryInput = z
  .object({
    request: z.string().trim().min(1).max(2000),
    teamId: z.number().int().positive().optional(),
    projectId: z.number().int().positive().optional(),
  })
  .strict();

export const discoveryTool = {
  name: 'discover_tools',
  description:
    'Find authorized planning tools for a task, optionally scoped to a team or project. Returns schemas and workflow guidance without executing tools. Describe the task without secrets or project content; the request and tool descriptions are sent to Jev through OpenRouter when configured.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      request: { type: 'string', minLength: 1, maxLength: 2000 },
      teamId: { type: 'integer', minimum: 1 },
      projectId: { type: 'integer', minimum: 1 },
    },
    required: ['request'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' as const, additionalProperties: true },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

function describe(tool: McpRouteTool) {
  const hidden = ['delegateUserId'];
  if (tool.name === 'create_team_project' || tool.name === 'update_project')
    hidden.push('description');
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: withoutFields(tool.inputSchema, hidden),
    annotations: tool.annotations,
    outputSchema: tool.outputSchema,
  };
}

export async function discoverTools(table: McpRouteTool[], userId: string, args: unknown) {
  const parsed = discoveryInput.safeParse(args);
  if (!parsed.success)
    throw new HttpError(
      400,
      'Provide a request of 1–2000 characters and optional positive teamId/projectId',
    );
  const { request, ...scope } = parsed.data;
  const authorized = await authorizedTools(
    table.filter((tool) => DISCOVERY_TOOLS.has(tool.name)),
    userId,
    scope,
  );
  const ranked = await rankTools(request, authorized);
  const supportingNames = new Set([
    'list_teams',
    'list_team_projects',
    'list_projects',
    'get_project',
  ]);
  if (ranked.tools.some((tool) => tool.name.includes('role'))) {
    supportingNames.add('list_roles');
    supportingNames.add('list_permission_catalog');
  }
  if (ranked.tools.some((tool) => tool.name.includes('member')))
    supportingNames.add('list_team_members');
  if (ranked.tools.some((tool) => tool.name.includes('issue')))
    supportingNames.add('search_issues');
  const supporting = authorized.filter(
    (tool) => supportingNames.has(tool.name) && !ranked.tools.includes(tool),
  );
  return {
    ...ranked,
    tools: ranked.tools.map(describe),
    supportingTools: ranked.tools.length ? supporting.map(describe) : [],
    instructions: [
      'Recommendations do not grant permission or execute actions. Call the named tool directly; its route rechecks access.',
      'Use tools/list for current names and schemas. Gateway clients prefix these native names with itsaplan__.',
      'Resolve team and project IDs using list_teams and list_team_projects/list_projects. For a specific target, repeat discovery with teamId/projectId; unscoped recommendations only describe capabilities available somewhere.',
      'Read get_project for column, issue type, label, and member IDs; use list_roles and list_permission_catalog for roles. Never invent IDs. Select columns by stateType.',
      'Read requests authorize reads only. Search before creating issues. Clarify ambiguous targets before writes; check current state before retrying a write.',
    ],
  };
}
