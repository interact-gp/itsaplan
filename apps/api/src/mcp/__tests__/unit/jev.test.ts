import { describe, expect, it } from 'bun:test';
import { selectTools } from '../../jev';
import { routeTools, mcpTool } from '../../generate';
import { Elysia } from 'elysia';

const tools = routeTools(
  new Elysia().get('/issues', () => [], {
    detail: { summary: 'List issues', ...mcpTool('list_issues') },
  }),
);

function decision(choice: string, confidence: number, probabilities: Record<string, number>) {
  return {
    model: 'typesafe/jev-test',
    answers: { tool: { type: 'choice', choice, confidence, probabilities } },
  };
}

describe('Jev discovery decisions', () => {
  it('accepts a valid authorized choice and a confident no-match', () => {
    const result = selectTools(
      decision('list_issues', 0.9, { list_issues: 0.9, none: 0.1 }),
      'list issues',
      tools,
    );
    expect(result.source).toBe('jev');
    expect(result.tools.map((tool) => tool.name)).toEqual(['list_issues']);
    expect(
      selectTools(decision('none', 1, { list_issues: 0, none: 1 }), 'weather', tools).tools,
    ).toEqual([]);
  });

  it('falls back on low confidence and malformed or unauthorized selections without adding tools', () => {
    const responses = [
      decision('list_issues', 0.2, { list_issues: 0.5, none: 0.5 }),
      decision('delete_project', 1, { delete_project: 1 }),
      decision('list_issues', 1, { list_issues: 1, none: 0, create_ai_agent: 0 }),
      decision('list_issues', 1, { none: 1 }),
      decision('list_issues', 1, { list_issues: 0.2, none: 0.8 }),
      { answers: null },
    ];
    for (const response of responses) {
      const result = selectTools(response, 'list issues', tools);
      expect(result.source).toBe('fallback');
      expect(result.tools.map((tool) => tool.name)).toEqual(['list_issues']);
    }
    expect(selectTools({}, 'weather', tools).tools).toEqual([]);
    expect(selectTools({}, 'list issues', []).tools).toEqual([]);
  });
});
