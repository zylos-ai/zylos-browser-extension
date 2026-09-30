import { expect, it } from 'vitest';
import {
  agentActivityFrameSchema,
  agentHistorySchema,
  appendAgentEvents,
  pruneAgentHistory,
} from '../../utils/agent-activity';

it('merges tool results by identity, bounds history, and explains omitted older entries', () => {
  const history = agentHistorySchema.parse({ status: 'running', startedAt: 1, events: [] });
  appendAgentEvents(history, [{ id: 'tool', kind: 'tool', at: 2, category: 'command' }]);
  appendAgentEvents(history, [
    { id: 'tool', kind: 'tool', at: 2, endedAt: 3, category: 'command' },
  ]);
  expect(history.events).toHaveLength(1);
  expect(history.events[0]).toMatchObject({ endedAt: 3 });
  appendAgentEvents(
    history,
    Array.from({ length: 600 }, (_, i) => ({
      id: `text-${i}`,
      kind: 'commentary',
      at: 4 + i,
      text: 'x'.repeat(2000),
    })),
    2,
  );
  expect(history.events).toHaveLength(500);
  expect(history.dropped).toBe(103);
  const chat = [{ agentHistory: history }];
  pruneAgentHistory(chat);
  expect(history.events).toHaveLength(250);
  expect(history.dropped).toBe(353);
});

it('rejects malformed history at the frame boundary and discards fields outside the display contract', () => {
  const frame = {
    type: 'agent-activity',
    endpointId: 'endpoint',
    taskId: 'task',
    sequence: 1,
    category: 'processing',
  };
  const event = { id: 'text', kind: 'commentary', at: 1, text: 'Public progress' };
  expect(
    agentActivityFrameSchema.safeParse({ ...frame, events: [{ ...event, text: 'x'.repeat(2001) }] })
      .success,
  ).toBe(false);
  expect(
    agentActivityFrameSchema.safeParse({ ...frame, events: [{ ...event, kind: 'reasoning' }] })
      .success,
  ).toBe(false);
  expect(
    agentActivityFrameSchema.safeParse({ ...frame, events: Array(101).fill(event) }).success,
  ).toBe(false);
  const parsed = agentActivityFrameSchema.parse({
    ...frame,
    events: [{ ...event, arguments: 'private', output: 'private', analysis: 'private' }],
  });
  expect(JSON.stringify(parsed)).not.toContain('private');
});
