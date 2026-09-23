// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserLoop,
  decisionSchema,
  type AgentRequest,
  type RoundResult,
  type LoopAction,
} from '../../utils/browser-loop';
import { selectionAttachment } from '../../utils/attachments';
import { setWorkerLanguage } from '../../utils/i18n';

function setup(timeout = 300000) {
  const requests: AgentRequest[] = [];
  const io = {
    send: vi.fn((request: AgentRequest) => {
      requests.push(request);
      return true;
    }),
    execute: vi.fn(async (_actions: LoopAction[]): Promise<RoundResult> => ({
      observation: { text: 'new page' },
      results: [],
      failed: false,
      mode: 'operating',
    })),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(),
    progress: vi.fn(),
  };
  const loop = new BrowserLoop(io, timeout);
  loop.start(
    'task-1',
    { role: 'user', content: [{ type: 'text', text: 'Search the current page' }] },
    { type: 'current-page', status: 'excerpt', contextId: '11111111-1111-4111-8111-111111111111' },
  );
  return { requests, io, loop };
}
const action = {
  kind: 'actions',
  actions: [{ method: 'open', params: { url: 'https://example.com' } }],
  memory: 'Need results',
};
beforeEach(() => setWorkerLanguage('en'));
afterEach(() => {
  vi.useRealTimers();
  setWorkerLanguage('auto');
});
describe('extension-owned loop', () => {
  it('sends owner attachments once, outside page observations, and retains the original task after actions', async () => {
    const { loop, requests } = setup();
    loop.cancel();
    requests.length = 0;
    const quote = selectionAttachment({
      text: 'Compare this passage',
      truncated: false,
      tabId: 3,
      documentId: 'doc-1',
      url: 'https://example.com/',
      title: 'Article',
    });
    loop.start(
      'task-with-quote',
      { role: 'user', content: [{ type: 'text', text: 'Explain' }, quote] },
      { type: 'current-page', status: 'excerpt', contextId: 'task-with-quote' },
    );
    expect(requests[0]!.message).toMatchObject({
      content: [
        { type: 'text', text: 'Explain' },
        { type: 'quote', text: quote.text, source: { contextId: 'task-with-quote' } },
      ],
    });
    expect(requests[0]).not.toHaveProperty('payload');
    expect(requests[0]).not.toHaveProperty('text');
    expect(requests[0]!.execution).not.toHaveProperty('initialPage');
    expect(requests[0]!.context.pages[0]).not.toHaveProperty('selection');
    loop.accept(requests[0]!.id, action);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.taskId).toBe('task-with-quote');
    expect(requests[1]!.message).toEqual({ id: 'task-with-quote' });
    expect(requests[1]!.context).toEqual({ pages: [] });
    expect(requests[1]!.execution).toHaveProperty('observation');
    loop.cancel();
  });
  it('stays read-only across multiple chunks and sends control schemas only after adoption', async () => {
    const { loop, requests, io } = setup();
    const read = {
      kind: 'actions',
      actions: [
        { method: 'read-page', params: { contextId: '11111111-1111-4111-8111-111111111111' } },
      ],
    };
    io.execute.mockResolvedValue({
      observation: { text: 'more text' },
      results: [],
      failed: false,
      mode: 'reading',
    });
    for (let i = 0; i < 3; i++) {
      loop.accept(requests[i]!.id, read);
      await vi.waitFor(() => expect(requests).toHaveLength(i + 2));
      expect(requests[i + 1]!.execution).toMatchObject({ mode: 'reading' });
      expect(requests[i + 1]!.execution).not.toHaveProperty('tools');
      expect(() =>
        loop.accept(requests[i + 1]!.id, {
          kind: 'actions',
          actions: [{ method: 'click', params: { ref: '@invented' } }],
        }),
      ).toThrow('enter browser control');
    }
    io.execute.mockResolvedValueOnce({
      observation: { text: 'controls' },
      results: [],
      failed: false,
      mode: 'operating',
    });
    loop.accept(requests[3]!.id, action);
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    expect(requests[4]!.execution).toMatchObject({
      mode: 'operating',
      tools: expect.arrayContaining([expect.objectContaining({ name: 'click' })]),
    });
    loop.cancel();
  });
  it('does not enter control after a failed selection and allows a final answer after a read', async () => {
    const { loop, requests, io } = setup();
    io.execute.mockResolvedValueOnce({
      observation: {},
      results: [],
      failed: true,
      mode: 'reading',
    });
    loop.accept(requests[0]!.id, action);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.execution).toMatchObject({ mode: 'reading' });
    expect(requests[1]!.execution).not.toHaveProperty('tools');
    loop.accept(requests[1]!.id, { kind: 'done', text: 'Here is the summary' });
    await vi.waitFor(() => expect(loop.active).toBe(false));
    expect(io.execute).toHaveBeenCalledTimes(1);
  });
  it('requires a content version for chunk continuation and keeps DOM reads standalone', () => {
    const read = {
      method: 'read-page',
      params: { contextId: '11111111-1111-4111-8111-111111111111', offset: 6000 },
    };
    expect(decisionSchema.safeParse({ kind: 'actions', actions: [read] }).success).toBe(false);
    expect(
      decisionSchema.safeParse({
        kind: 'actions',
        actions: [{ ...read, params: { ...read.params, contentVersion: '12000-ab' } }],
      }).success,
    ).toBe(true);
    expect(
      decisionSchema.safeParse({
        kind: 'actions',
        actions: [
          { method: 'fill', params: { ref: '@real', text: 'query' } },
          { method: 'read-page', params: { ...read.params, offset: 0 } },
        ],
      }).success,
    ).toBe(false);
  });
  it('enforces the total deadline even when an operation never resolves', async () => {
    vi.useFakeTimers();
    const { loop, requests, io } = setup();
    io.execute.mockImplementationOnce(() => new Promise(() => {}));
    loop.accept(requests[0]!.id, action);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(loop.active).toBe(false);
    expect(io.finish).toHaveBeenCalledWith(
      expect.stringContaining('time limit'),
      'blocked',
      'task-1',
      { kind: 'time-limit' },
    );
  });
  it('answers ordinary chat without any browser action', async () => {
    const { loop, requests, io } = setup();
    loop.accept(requests[0]!.id, { kind: 'done', text: 'Hello' });
    await vi.waitFor(() => expect(loop.active).toBe(false));
    expect(io.execute).not.toHaveBeenCalled();
    expect(io.finish).toHaveBeenCalledWith('Hello', 'done', 'task-1');
  });
  it('automatically sends fresh evidence and memory after executing one decision', async () => {
    const { loop, requests, io } = setup();
    const id = requests[0]!.id;
    expect(loop.accept(id, action).replayed).toBe(false);
    expect(loop.accept(id, action).replayed).toBe(true);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(io.execute).toHaveBeenCalledTimes(1);
    expect(requests[1]!.execution).toMatchObject({
      memory: 'Need results',
      observation: { text: 'new page' },
    });
    expect(requests[1]!.execution).toHaveProperty('tools');
    expect(() => loop.accept(id, { kind: 'done', text: 'changed' })).toThrow('different contents');
    loop.cancel();
  });
  it('publishes user-facing summaries once after validation without exposing memory or adding requests', async () => {
    const { loop, requests, io } = setup();
    const id = requests[0]!.id;
    expect(() => loop.accept(id, { ...action, summary: 'x'.repeat(161) })).toThrow();
    expect(io.progress).not.toHaveBeenCalled();
    const decision = { ...action, summary: '打开页面查找相关信息' };
    loop.accept(id, decision);
    loop.accept(id, decision);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(io.progress).toHaveBeenCalledExactlyOnceWith('打开页面查找相关信息');
    expect(io.execute).toHaveBeenCalledTimes(1);
    loop.accept(requests[1]!.id, {
      kind: 'actions',
      actions: [{ method: 'scroll', params: { direction: 'down', pixels: 500 } }],
      memory: 'private task notes',
    });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(io.progress).toHaveBeenLastCalledWith(undefined);
    expect(JSON.stringify(io.progress.mock.calls)).not.toContain('private task notes');
    loop.cancel();
  });
  it('delivers action constraints with the browser schemas, without resending them every round', async () => {
    const { loop, requests } = setup();
    const initial = requests[0]!.execution as { tools: { name: string }[] };
    expect(initial.tools.map((tool) => tool.name)).toEqual([
      'read-page',
      'use-current-tab',
      'open',
    ]);
    loop.accept(requests[0]!.id, action);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const payload = requests[1]!.execution as {
      tools: { name: string; constraints?: string[]; examples?: unknown[] }[];
    };
    const constraints = (name: string) =>
      payload.tools.find((tool) => tool.name === name)?.constraints?.join(' ') || '';
    expect(constraints('click')).toContain('leave an already-correct state alone');
    expect(constraints('inspect')).toContain('Buffering does not justify repeatedly toggling');
    expect(constraints('inspect')).toContain('readyState >= 3');
    expect(constraints('keypress')).toContain('do not blindly retry without the ref');
    expect(payload.tools.find((tool) => tool.name === 'find')?.examples).toContainEqual({
      selector: 'video,audio',
    });
    loop.accept(requests[1]!.id, {
      kind: 'actions',
      actions: [{ method: 'find', params: { selector: 'video,audio' } }],
    });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]!.execution).not.toHaveProperty('tools');
    expect(requests[2]!.execution).not.toHaveProperty('instructions');
    loop.cancel();
  });
  it('validates the entire batch before consuming the pending decision', () => {
    const { loop, requests, io } = setup();
    const id = requests[0]!.id;
    expect(() =>
      loop.accept(id, {
        kind: 'actions',
        actions: [
          { method: 'fill', params: { ref: '@a', text: 'hello' } },
          { method: 'click', params: {} },
        ],
      }),
    ).toThrow();
    expect(io.execute).not.toHaveBeenCalled();
    expect(loop.accept(id, action).accepted).toBe(true);
    loop.cancel();
  });
  it('rejects a decision after stop and ignores old work completion', async () => {
    const { loop, requests, io } = setup();
    let release!: () => void;
    io.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ observation: { text: '' }, results: [], failed: false, mode: 'operating' });
        }),
    );
    loop.accept(requests[0]!.id, action);
    loop.cancel();
    release();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    loop.start(
      'new-turn',
      { role: 'user', content: [{ type: 'text', text: 'new' }] },
      { type: 'current-page', status: 'unavailable' },
    );
    const next = requests[1]!.id;
    loop.cancel();
    expect(() => loop.accept(next, action)).toThrow('no longer active');
    expect(io.finish).not.toHaveBeenCalled();
  });
  it('keeps malformed decisions pending, rejects unknown IDs, and bounds waiting', async () => {
    vi.useFakeTimers();
    const { loop, requests, io } = setup(1000);
    expect(() => loop.accept(requests[0]!.id, { kind: 'done', text: '' })).toThrow();
    expect(() => loop.accept('unknown', action)).toThrow('no longer active');
    await vi.advanceTimersByTimeAsync(1000);
    expect(loop.active).toBe(false);
    expect(io.finish).toHaveBeenCalledWith(
      expect.stringContaining('Timed out'),
      'interrupted',
      'task-1',
      { kind: 'request-failed', code: 'DECISION_TIMEOUT' },
    );
  });
  it('uses the worker language for interrupted task text and keeps localization metadata', async () => {
    const { loop, requests, io } = setup();
    setWorkerLanguage('zh-CN');
    io.execute.mockRejectedValueOnce(new Error('Transport detail'));
    loop.accept(requests[0]!.id, action);
    await vi.waitFor(() => expect(loop.active).toBe(false));
    expect(io.finish).toHaveBeenCalledWith(
      expect.stringContaining('浏览器任务中断'),
      'interrupted',
      'task-1',
      { kind: 'interrupted' },
    );
  });
  it('stops after three failed rounds without replaying any action automatically', async () => {
    const { loop, requests, io } = setup();
    io.execute.mockResolvedValue({
      observation: { text: '' },
      results: [],
      failed: true,
      mode: 'reading',
    });
    for (let i = 0; i < 3; i++) {
      loop.accept(requests[i]!.id, action);
      await vi.waitFor(() => expect(io.execute).toHaveBeenCalledTimes(i + 1));
      await Promise.resolve();
    }
    await vi.waitFor(() => expect(loop.active).toBe(false));
    expect(requests).toHaveLength(3);
    expect(io.finish).toHaveBeenCalledWith(
      expect.stringContaining('execution limit'),
      'blocked',
      'task-1',
      { kind: 'execution-limit' },
    );
  });
  it('permits known form edits plus one final action, but not speculative multi-page batches', () => {
    const fill = { method: 'fill', params: { ref: '@real', text: 'query' } };
    expect(
      decisionSchema.safeParse({
        kind: 'actions',
        actions: [fill, { method: 'keypress', params: { key: 'Enter' } }],
      }).success,
    ).toBe(true);
    expect(
      decisionSchema.safeParse({ ...action, actions: [action.actions[0], fill] }).success,
    ).toBe(false);
    expect(decisionSchema.safeParse({ ...action, actions: Array(6).fill(fill) }).success).toBe(
      false,
    );
  });
});

it('records findings before scroll, keeps notes across rounds and refuses incomplete done', async () => {
  const { loop, requests, io } = setup();
  loop.accept(requests[0]!.id, action);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  const finding = {
    key: 'a',
    title: 'App A',
    summary: 'Observed candidate',
    sourceUrl: 'https://example.com',
    position: 1,
  };
  const record = {
    method: 'record-findings',
    params: { collection: 'list', targetCount: 2, items: [finding] },
  };
  const scroll = { method: 'scroll', params: { direction: 'down' } };
  loop.accept(requests[1]!.id, { kind: 'actions', actions: [record, scroll] });
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  expect(io.execute.mock.calls.at(-1)?.[0]).toEqual([scroll]);
  expect(requests[2]!.execution.research?.collections[0]).toMatchObject({
    collected: 1,
    remaining: 1,
  });
  loop.accept(requests[2]!.id, { kind: 'done', text: 'All done' });
  await vi.waitFor(() => expect(requests).toHaveLength(4));
  expect(io.finish).not.toHaveBeenCalled();
  expect(requests[3]!.execution.results).toContainEqual(
    expect.objectContaining({ status: 'incomplete' }),
  );
  loop.accept(requests[3]!.id, {
    kind: 'actions',
    actions: [{ method: 'read-findings', params: {} }],
  });
  await vi.waitFor(() => expect(requests).toHaveLength(5));
  expect(io.execute).toHaveBeenCalledTimes(2);
  expect(requests[4]!.execution.results).toContainEqual(
    expect.objectContaining({
      result: expect.objectContaining({ items: [expect.objectContaining(finding)] }),
    }),
  );
  loop.accept(requests[4]!.id, { kind: 'blocked', text: 'Only one of two entries could be read' });
  await vi.waitFor(() => expect(loop.active).toBe(false));
  expect(io.finish).toHaveBeenCalledWith(expect.any(String), 'blocked', 'task-1');
  loop.start(
    'new',
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { type: 'current-page', status: 'unavailable' },
  );
  expect(requests.at(-1)!.execution.research).toBeUndefined();
  loop.cancel();
});

it('notes reuse the last text observation without retransmitting screenshot bytes', async () => {
  const { loop, requests, io } = setup();
  io.execute.mockResolvedValueOnce({
    mode: 'operating',
    failed: false,
    results: [],
    observation: { page: { text: 'Observed page', screenshot: { type: 'image', data: 'pixels' } } },
  });
  loop.accept(requests[0]!.id, action);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  loop.accept(requests[1]!.id, {
    kind: 'actions',
    actions: [{ method: 'record-findings', params: { collection: 'notes', items: [] } }],
  });
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]!.execution.observation).toEqual({
    reused: true,
    page: { text: 'Observed page' },
  });
  expect(io.execute).toHaveBeenCalledTimes(1);
  loop.cancel();
});
