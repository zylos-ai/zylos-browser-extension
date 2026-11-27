import { describe, expect, it } from 'vitest';
import {
  planTaskAppend,
  TASK_APPEND_LIMIT,
  TASK_APPEND_WINDOW_MS,
  taskAppendSchema,
} from '../../utils/agent-task-append';
import type { ChatEntry } from '../../utils/remote';

const now = 1_800_000_000_000;
const id = (n: number) => n.toString(16).padStart(32, '0');
const task = (loopStatus: ChatEntry['loopStatus'], endedAt = now - 1000): ChatEntry => ({
  id: 'task-1',
  role: 'user',
  text: 'Ask a reviewer',
  ts: endedAt - 5000,
  loopStatus,
  agentHistory: { status: 'completed', startedAt: endedAt - 5000, endedAt, events: [], dropped: 0 },
});
const input = (n = 1, text = 'Result') => ({ taskId: 'task-1', appendId: id(n), text });
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('planTaskAppend', () => {
  it('appends a trimmed text-only follow-up to a task the Agent answered', () => {
    for (const status of ['done', 'blocked'] as const) {
      const plan = planTaskAppend([task(status)], input(1, '  Result  '), { now });
      expect(plan.result).toEqual({
        taskId: 'task-1',
        appendId: id(1),
        status: 'appended',
        count: 1,
        limit: TASK_APPEND_LIMIT,
      });
      expect(plan.entry).toEqual({
        id: `append:${id(1)}`,
        role: 'assistant',
        text: 'Result',
        final: true,
        followUp: true,
        taskId: 'task-1',
        ts: now,
      });
    }
  });
  it('rejects unknown, running, stopped and interrupted tasks', () => {
    expect(code(() => planTaskAppend([], input(), { now }))).toBe('TASK_UNKNOWN');
    expect(
      code(() => planTaskAppend([{ ...task('done'), role: 'assistant' }], input(), { now })),
    ).toBe('TASK_UNKNOWN');
    expect(code(() => planTaskAppend([task('active')], input(), { now }))).toBe('TASK_ACTIVE');
    expect(code(() => planTaskAppend([task(undefined)], input(), { now }))).toBe('TASK_ACTIVE');
    expect(
      code(() => planTaskAppend([task('done')], input(), { now, activeTaskId: 'task-1' })),
    ).toBe('TASK_ACTIVE');
    expect(code(() => planTaskAppend([task('stopped')], input(), { now }))).toBe(
      'TASK_NOT_APPENDABLE',
    );
    expect(code(() => planTaskAppend([task('interrupted')], input(), { now }))).toBe(
      'TASK_NOT_APPENDABLE',
    );
  });
  it('allows exactly 24 hours after the end, then refuses', () => {
    const edge = task('done', now - TASK_APPEND_WINDOW_MS);
    expect(planTaskAppend([edge], input(), { now }).entry).toBeDefined();
    expect(
      code(() => planTaskAppend([task('done', now - TASK_APPEND_WINDOW_MS - 1)], input(), { now })),
    ).toBe('TASK_TOO_OLD');
    const legacy = {
      ...task('done'),
      agentHistory: undefined,
      ts: now - TASK_APPEND_WINDOW_MS - 1,
    };
    expect(code(() => planTaskAppend([legacy], input(), { now }))).toBe('TASK_TOO_OLD');
  });
  it('limits follow-ups per task and is idempotent per append ID', () => {
    const chat: ChatEntry[] = [task('done')];
    for (let n = 1; n <= TASK_APPEND_LIMIT; n++) {
      const plan = planTaskAppend(chat, input(n, `r${n}`), { now });
      expect(plan.result.count).toBe(n);
      chat.push(plan.entry!);
    }
    expect(code(() => planTaskAppend(chat, input(99), { now }))).toBe('TASK_APPEND_LIMIT');
    // A retry of an existing follow-up still answers, even at the limit or after the window.
    const again = planTaskAppend(chat, input(3, 'r3'), { now: now + 2 * TASK_APPEND_WINDOW_MS });
    expect(again).toEqual({ result: expect.objectContaining({ status: 'existing', count: 3 }) });
    expect(code(() => planTaskAppend(chat, input(3, 'different'), { now }))).toBe(
      'TASK_APPEND_CONFLICT',
    );
    // Other tasks' follow-ups do not count.
    expect(
      planTaskAppend(
        [...chat, { ...task('done'), id: 'task-2' }],
        { ...input(50), taskId: 'task-2' },
        { now },
      ).result.count,
    ).toBe(1);
  });
  it('accepts only the relay wire shape', () => {
    expect(taskAppendSchema.safeParse(input()).success).toBe(true);
    for (const bad of [
      { ...input(), appendId: 'x' },
      { ...input(), taskId: 'a b' },
      { ...input(), text: '  ' },
      { ...input(), text: 'x'.repeat(8001) },
      { ...input(), actions: [] },
    ])
      expect(taskAppendSchema.safeParse(bad).success).toBe(false);
  });
});
