// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserLoop, decisionSchema, type AgentRequest } from '../../utils/browser-loop';

function setup(timeout = 300000) {
  const requests: AgentRequest[] = [];
  const io = {
    send: vi.fn((request: AgentRequest) => {
      requests.push(request);
      return true;
    }),
    execute: vi.fn(async () => ({ observation: { text: 'new page' }, results: [], failed: false })),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
  const loop = new BrowserLoop(io, timeout);
  loop.start(
    'task-1',
    'Search the current page',
    JSON.stringify({ contextId: '11111111-1111-4111-8111-111111111111' }),
  );
  return { requests, io, loop };
}
const action = {
  kind: 'actions',
  actions: [{ method: 'open', params: { url: 'https://example.com' } }],
  memory: 'Need results',
};
afterEach(() => vi.useRealTimers());
describe('extension-owned loop', () => {
  it('enforces the total deadline even when an operation never resolves', async () => {
    vi.useFakeTimers();
    const { loop, requests, io } = setup();
    io.execute.mockImplementationOnce(() => new Promise(() => {}));
    loop.accept(requests[0]!.id, action);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(loop.active).toBe(false);
    expect(io.finish).toHaveBeenCalledWith(
      expect.stringContaining('时间上限'),
      'blocked',
      'task-1',
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
    expect(requests[1]!.payload).toMatchObject({
      memory: 'Need results',
      observation: { text: 'new page' },
    });
    expect(requests[1]!.payload).toHaveProperty('tools');
    expect(() => loop.accept(id, { kind: 'done', text: 'changed' })).toThrow('different contents');
    loop.cancel();
  });
  it('delivers action constraints with the browser schemas, without resending them every round', async () => {
    const { loop, requests } = setup();
    const initial = requests[0]!.payload as { tools: { name: string }[] };
    expect(initial.tools.map((tool) => tool.name)).toEqual(['use-current-tab', 'open']);
    loop.accept(requests[0]!.id, action);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const payload = requests[1]!.payload as {
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
    expect(requests[2]!.payload).not.toHaveProperty('tools');
    expect(requests[2]!.payload).not.toHaveProperty('instructions');
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
          release = () => resolve({ observation: { text: '' }, results: [], failed: false });
        }),
    );
    loop.accept(requests[0]!.id, action);
    loop.cancel();
    release();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    loop.start('new-turn', 'new', '{}');
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
      expect.stringContaining('超时'),
      'interrupted',
      'task-1',
    );
  });
  it('stops after three failed rounds without replaying any action automatically', async () => {
    const { loop, requests, io } = setup();
    io.execute.mockResolvedValue({ observation: { text: '' }, results: [], failed: true });
    for (let i = 0; i < 3; i++) {
      loop.accept(requests[i]!.id, action);
      await vi.waitFor(() => expect(io.execute).toHaveBeenCalledTimes(i + 1));
      await Promise.resolve();
    }
    await vi.waitFor(() => expect(loop.active).toBe(false));
    expect(requests).toHaveLength(3);
    expect(io.finish).toHaveBeenCalledWith(expect.stringContaining('上限'), 'blocked', 'task-1');
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
