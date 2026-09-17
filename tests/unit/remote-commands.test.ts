// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executor = vi.hoisted(() => ({
  createTask: vi.fn(),
  execute: vi.fn(),
  currentControl: vi.fn((): null | { sessionId: string; tabId: number; tabIds: number[] } => null),
  currentGrant: vi.fn((): null | { id: number; url: string } => null),
}));
vi.mock('../../utils/automation/executor', () => executor);

import {
  IdempotencyCache,
  REMOTE_CAPABILITIES,
  RemoteError,
  dispatch,
} from '../../utils/remote-commands';

const call = (
  method: string,
  params: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => dispatch({ method, params, keyId: 'abcdef012345', ...extra }, idem);
const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RemoteError);
  expect((err as RemoteError).code).toBe(code);
  return err as RemoteError;
};
let idem: IdempotencyCache;

beforeEach(() => {
  vi.clearAllMocks();
  idem = new IdempotencyCache(3);
  executor.currentControl.mockReturnValue(null);
  executor.currentGrant.mockReturnValue(null);
  executor.execute.mockImplementation(async (c: { op: string }) => ({ ran: c.op }));
  executor.createTask.mockImplementation(async () => {
    executor.currentControl.mockReturnValue({
      sessionId: '22222222-2222-4222-8222-222222222222',
      tabId: 7,
      tabIds: [7],
    });
    executor.currentGrant.mockReturnValue({ id: 7, url: 'https://example.com/' });
    return { id: 7, url: 'https://example.com/' };
  });
  vi.stubGlobal('chrome', {
    windows: { getLastFocused: vi.fn(async () => ({ id: 1, incognito: false })) },
    tabs: { query: vi.fn(async () => [{ id: 3, windowId: 1 }]) },
  });
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
});

describe('remote dispatch', () => {
  it('refuses unknown methods and bad params before touching the executor', async () => {
    await rejects(call('Runtime.evaluate', { expression: '1' }), 'UNKNOWN_METHOD');
    await rejects(call('click', {}), 'BAD_PARAMS');
    await rejects(call('click', { ref: 'e1', extra: true }), 'BAD_PARAMS');
    await rejects(call('open', { url: 'not a url' }), 'BAD_PARAMS');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('info needs no task and advertises capabilities', async () => {
    const r = (await call('info')) as { capabilities: string[]; keyId: string };
    expect(r.keyId).toBe('abcdef012345');
    expect(r.capabilities).toEqual(REMOTE_CAPABILITIES);
    expect(r.capabilities).toContain('open');
    expect(r.capabilities).toContain('idempotency-v1');
    expect(r.capabilities).toContain('describe');
    expect(r.capabilities).toContain('tool-catalog-v1');
  });

  it('serves the live guide and parameter schemas without taking browser control', async () => {
    executor.currentGrant.mockReturnValue({ id: 7, url: 'https://www.chase.com/login' });
    const guide = (await call('describe')) as { instructions: string; tools: { name: string }[] };
    expect(guide.instructions).toContain('Browser operation guide');
    expect(guide.tools.some((tool) => tool.name === 'click')).toBe(true);
    const details = (await call('describe', { methods: ['fill', 'observe'] })) as {
      tools: { name: string; parameters: unknown }[];
    };
    expect(details.tools.map((tool) => tool.name)).toEqual(['fill', 'observe']);
    expect(details.tools[0]?.parameters).toMatchObject({ required: ['ref', 'text'] });
    await rejects(call('describe', { method: 'invented' }), 'UNKNOWN_METHOD');
    await rejects(call('describe', { method: 'click', methods: ['click'] }), 'BAD_PARAMS');
    await rejects(call('describe', { methods: [] }), 'BAD_PARAMS');
    await rejects(call('describe', { extra: true }), 'BAD_PARAMS');
    expect(executor.createTask).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('open with no task creates the task tab beside the active tab, then navigates the task tab', async () => {
    const first = (await call('open', { url: 'https://example.com/' })) as {
      started: boolean;
      tabId: number;
    };
    expect(first.started).toBe(true);
    expect(first.tabId).toBe(7);
    expect(executor.createTask).toHaveBeenCalledWith({
      sourceTabId: 3,
      url: 'https://example.com/',
      taskId: '11111111-1111-4111-8111-111111111111',
      windowId: 1,
    });
    expect(executor.execute).not.toHaveBeenCalled();

    await call('open', { url: 'https://example.com/b' });
    expect(executor.execute).toHaveBeenCalledWith(
      { op: 'open', url: 'https://example.com/b' },
      expect.any(Number),
    );
    await rejects(call('start', { url: 'https://example.com/c' }), 'TASK_ALREADY_STARTED');
  });

  it('refuses to start in an incognito or missing window', async () => {
    (chrome.windows.getLastFocused as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      incognito: true,
    });
    await rejects(call('open', { url: 'https://example.com/' }), 'NO_WINDOW');
  });

  it('maps executor commands 1:1 and fills finalize taskId from the task', async () => {
    await call('open', { url: 'https://example.com/' });
    await call('click', { ref: 'e12' });
    await call('scroll', { direction: 'down' });
    await call('finalize', { keep: [7] });
    expect(executor.execute.mock.calls.map((c) => c[0])).toEqual([
      { op: 'click', ref: 'e12' },
      { op: 'scroll', direction: 'down', pixels: 500 },
      { op: 'finalize', taskId: '22222222-2222-4222-8222-222222222222', keep: [7] },
    ]);
  });

  it('blocks navigation to blocklisted URLs and interaction while parked on one', async () => {
    const e = await rejects(call('open', { url: 'https://shop.example/checkout' }), 'BLOCKED_URL');
    expect(e.details).toEqual({ url: 'https://shop.example/checkout' });
    await call('open', { url: 'https://example.com/' });
    executor.currentGrant.mockReturnValue({ id: 7, url: 'https://www.chase.com/login' });
    await rejects(call('snapshot'), 'BLOCKED_URL');
    await rejects(call('click', { ref: 'e1' }), 'BLOCKED_URL');
    await rejects(call('screenshot'), 'BLOCKED_URL');
    // The way out stays open.
    await expect(call('open', { url: 'https://example.com/' })).resolves.toBeTruthy();
    await expect(call('stop')).resolves.toBeTruthy();
    await expect(call('tabs')).resolves.toBeTruthy();
  });

  it('only actual execution resumes previews; cached and rejected requests do not', async () => {
    const onExecute = vi.fn();
    const req = {
      method: 'click',
      params: { ref: 'e1' },
      requestId: 'preview-r1',
      keyId: 'abcdef012345',
    };
    await dispatch(req, idem, undefined, onExecute);
    await dispatch(req, idem, undefined, onExecute);
    await rejects(
      dispatch({ ...req, requestId: 'bad', params: {} }, idem, undefined, onExecute),
      'BAD_PARAMS',
    );
    expect(onExecute).toHaveBeenCalledOnce();
  });

  it('replays a retried mutating call instead of executing it twice', async () => {
    await call('open', { url: 'https://example.com/' });
    const a = await call('click', { ref: 'e1' }, { requestId: 'r1' });
    const b = (await call('click', { ref: 'e1' }, { requestId: 'r1' })) as { replayed?: boolean };
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(b).toEqual({ ...(a as object), replayed: true });
    // Reads are never cached.
    await call('snapshot', {}, { requestId: 'r2' });
    await call('snapshot', {}, { requestId: 'r2' });
    expect(executor.execute).toHaveBeenCalledTimes(3);
  });

  it('idempotency cache evicts oldest', () => {
    idem.set('a', 1);
    idem.set('b', 2);
    idem.set('c', 3);
    idem.get('a');
    idem.set('d', 4);
    expect(idem.get('b')).toBeUndefined();
    expect(idem.get('a')).toBe(1);
    expect(idem.size).toBe(3);
  });

  it('honours the relay deadline', async () => {
    await rejects(call('info', {}, { deadline: Date.now() - 1 }), 'COMMAND_EXPIRED');
  });
});

describe('one action with a result observation', () => {
  const read = { op: 'snapshot' };
  const click = { op: 'click', ref: '@a-e1' };
  const establish = () =>
    executor.currentControl.mockReturnValue({ sessionId: 'task', tabId: 7, tabIds: [7] });

  it('opens, waits and reads in order within one deadline, exposing the actual stages', async () => {
    const events: string[] = [];
    const result = await dispatch(
      {
        method: 'step',
        params: {
          action: { op: 'open', url: 'https://example.com/' },
          read,
        },
        deadline: Date.now() + 20000,
        keyId: 'abc',
      },
      idem,
      undefined,
      undefined,
      (method) => {
        events.push(method);
        return { finish: (error) => events.push(error ?? 'ok') };
      },
    );
    expect(result).toMatchObject({
      completed: true,
      steps: [
        { stage: 'action', method: 'open', status: 'success', result: { started: true } },
        { stage: 'wait', method: 'wait', status: 'success' },
        { stage: 'read', method: 'snapshot', status: 'success' },
      ],
    });
    expect(executor.execute.mock.calls.map(([c]) => c)).toEqual([
      { op: 'wait', condition: 'loaded', timeoutMs: 10000 },
      { op: 'snapshot', interactive: false },
    ]);
    expect(executor.execute.mock.calls[0]![1]).toBe(executor.execute.mock.calls[1]![1]);
    expect(events).toEqual(['open', 'ok', 'wait', 'ok', 'snapshot', 'ok']);
  });

  it.each([
    { action: { op: 'click', x: 1 }, read },
    { action: click, wait: { condition: 'visible' }, read },
    { action: click, wait: { condition: 'loaded' }, read },
    { action: click, wait: { condition: 'new-tab' }, read },
    { action: click, wait: { condition: 'navigation', url: 'https://guessed.example/' }, read },
    { action: click, wait: { condition: 'navigation', selector: '#next' }, read },
    {
      action: { op: 'open', url: 'https://example.com/' },
      wait: { condition: 'navigation' },
      read,
    },
    { action: click, read: { op: 'fill', ref: 'x', text: 'second mutation' } },
    { action: { op: 'step' }, read },
    { action: { op: 'stop' }, read },
    { action: click, read: { op: 'find', selector: '' } },
  ])('validates the whole sequence before any action: %j', async (params) => {
    await rejects(call('step', params), 'BAD_PARAMS');
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.createTask).not.toHaveBeenCalled();
  });

  it('caches partial failure, preserves executed actions, skips the read and rejects changed request IDs', async () => {
    establish();
    executor.execute.mockImplementation(async (command) => {
      if (command.op === 'wait')
        throw Object.assign(new Error('unmet condition'), { code: 'WAIT_TIMEOUT' });
      return { done: true };
    });
    const params = { action: click, wait: { condition: 'visible', selector: '#next' }, read };
    const failed = await rejects(call('step', params, { requestId: 'partial' }), 'STEP_INCOMPLETE');
    expect(failed.details).toMatchObject({
      completed: false,
      steps: [
        { method: 'click', status: 'success' },
        { method: 'wait', status: 'error', error: { code: 'WAIT_TIMEOUT' } },
        { method: 'snapshot', status: 'skipped' },
      ],
    });
    const retry = await rejects(call('step', params, { requestId: 'partial' }), 'STEP_INCOMPLETE');
    expect(retry.details).toMatchObject({ replayed: true });
    await rejects(
      call('step', { ...params, action: { ...click, ref: 'other' } }, { requestId: 'partial' }),
      'REQUEST_ID_CONFLICT',
    );
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('captures navigation inside the action and shares it only with its waiting stage', async () => {
    establish();
    const checkpoint = { sessionId: 'task', tabId: 7, url: 'https://example.com/', revision: 3 };
    executor.execute.mockImplementation(async (command, _deadline, watch) => {
      if (command.op === 'click') watch.before = checkpoint;
      if (command.op === 'wait') expect(watch.before).toEqual(checkpoint);
      return { done: true };
    });
    const result = await call('step', { action: click, wait: { condition: 'navigation' }, read });
    expect(result).toMatchObject({ completed: true });
    const calls = executor.execute.mock.calls;
    expect(calls.map(([c]) => c.op)).toEqual(['click', 'wait', 'snapshot']);
    expect(calls[1]![0]).toEqual({ op: 'wait', condition: 'loaded', timeoutMs: 10000 });
    expect(calls[0]![2]).toBe(calls[1]![2]);
    expect(calls[2]![2]).toBeUndefined();
  });

  it('waits for load when an action already reports navigation, without a predicted URL', async () => {
    establish();
    executor.execute.mockResolvedValueOnce({
      done: true,
      navigating: true,
      needsObservation: true,
    });
    const result = await call('step', { action: click, read });
    expect(executor.execute.mock.calls.map(([c]) => c.op)).toEqual(['click', 'wait', 'snapshot']);
    expect(result).toMatchObject({
      completed: true,
      steps: [
        { status: 'success' },
        { stage: 'wait', status: 'success' },
        { stage: 'read', status: 'success' },
      ],
    });
    expect(executor.execute.mock.calls[1]![0]).toEqual({
      op: 'wait',
      condition: 'loaded',
      timeoutMs: 10000,
    });
  });

  it('replays uncertain mutation errors too instead of trying the action again', async () => {
    establish();
    executor.execute.mockRejectedValueOnce(
      Object.assign(new Error('lost acknowledgement'), { code: 'PAGE_CHANGED' }),
    );
    const params = { action: click, read };
    const failed = await rejects(
      call('step', params, { requestId: 'uncertain' }),
      'STEP_INCOMPLETE',
    );
    expect(failed.details).toMatchObject({ steps: [{ status: 'error' }, { status: 'skipped' }] });
    await rejects(call('step', params, { requestId: 'uncertain' }), 'STEP_INCOMPLETE');
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('guards both the initial URL and a redirect before the read', async () => {
    const blocked = await rejects(
      call('step', { action: { op: 'open', url: 'https://example.com/checkout' }, read }),
      'STEP_INCOMPLETE',
    );
    expect(blocked.details).toMatchObject({
      steps: [{ error: { code: 'BLOCKED_URL' } }, { status: 'skipped' }, { status: 'skipped' }],
    });
    expect(executor.createTask).not.toHaveBeenCalled();
    establish();
    executor.execute.mockImplementationOnce(async () => {
      executor.currentGrant.mockReturnValue({ id: 7, url: 'https://example.com/checkout' });
      return { done: true };
    });
    const redirected = await rejects(call('step', { action: click, read }), 'STEP_INCOMPLETE');
    expect(redirected.details).toMatchObject({
      steps: [{ status: 'success' }, { error: { code: 'BLOCKED_URL' } }],
    });
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('keeps one queue slot, coalesces duplicates and does not interleave another action', async () => {
    establish();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    executor.execute.mockImplementationOnce(async () => {
      await gate;
      return { done: true };
    });
    const first = call('step', { action: click, read }, { requestId: 'batch' });
    const retry = call('step', { action: click, read }, { requestId: 'batch' });
    const next = call('fill', { ref: 'later', text: 'later' });
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1));
    release();
    await first;
    expect(await retry).toMatchObject({ completed: true, replayed: true });
    await next;
    expect(executor.execute.mock.calls.map(([c]) => c.op)).toEqual(['click', 'snapshot', 'fill']);
    await call('step', { action: click, read }, { requestId: 'batch' });
    expect(executor.execute).toHaveBeenCalledTimes(3);
    expect(await call('step', { action: click, read }, { requestId: 'batch' })).toMatchObject({
      steps: [{ status: 'success' }, { result: { omittedFromReplay: true } }],
    });
  });

  it('stop interrupts the composite and cancels queued mutations without continuing to read', async () => {
    establish();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    executor.execute.mockImplementation(async (command) => {
      if (command.op === 'wait') {
        await gate;
        throw Object.assign(new Error('stopped'), { code: 'STOPPED' });
      }
      return { done: true };
    });
    const active = rejects(
      call('step', { action: click, wait: { condition: 'visible', selector: '#later' }, read }),
      'STEP_INCOMPLETE',
    );
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(2));
    const queued = rejects(call('click', { ref: 'later' }), 'STOPPED');
    await call('stop');
    release();
    expect((await active).details).toMatchObject({
      steps: [{ status: 'success' }, { error: { code: 'STOPPED' } }, { status: 'skipped' }],
    });
    await queued;
    expect(executor.execute.mock.calls.map(([c]) => c.op)).toEqual(['click', 'wait', 'stop']);
  });

  it('does not read a different task target after a waiting stage', async () => {
    establish();
    executor.execute.mockImplementation(async (command) => {
      if (command.op === 'wait')
        executor.currentControl.mockReturnValue({ sessionId: 'other', tabId: 9, tabIds: [9] });
      return { done: true };
    });
    const failed = await rejects(
      call('step', { action: click, wait: { condition: 'visible', selector: '#later' }, read }),
      'STEP_INCOMPLETE',
    );
    expect(failed.details).toMatchObject({
      steps: [{ status: 'success' }, { status: 'success' }, { error: { code: 'STOPPED' } }],
    });
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('does not grant each stage a fresh timeout budget', async () => {
    establish();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      executor.execute.mockImplementationOnce(async () => {
        clock.mockReturnValue(now + 101);
        return { done: true };
      });
      const failed = await rejects(
        call('step', { action: click, read }, { deadline: now + 100 }),
        'STEP_INCOMPLETE',
      );
      expect(failed.details).toMatchObject({
        steps: [{ status: 'success' }, { error: { code: 'COMMAND_EXPIRED' } }],
      });
      expect(executor.execute).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('browser actions v2', () => {
  it('validates every new action before dispatch, retaining the thin relay contract', async () => {
    await call('open', { url: 'https://example.com/' });
    for (const [method, params] of [
      ['hover', { x: 10, y: 20 }],
      ['double-click', { ref: '@a-e1' }],
      ['right-click', { ref: '@a-e1' }],
      ['drag', { from: { ref: '@a-e1' }, to: { x: 90, y: 100 } }],
      ['keypress', { key: 'a', modifiers: ['Control'] }],
      ['select', { ref: '@a-e1', values: ['b'] }],
      ['check', { ref: '@a-e1', checked: false }],
      ['scroll', { ref: '@a-e1', direction: 'down' }],
      ['find', { selector: '#input', frameId: 'child' }],
      ['wait', { condition: 'clickable', selector: '#ready' }],
      ['dialog', { action: 'accept', promptText: 'hello' }],
      ['back', {}],
      ['forward', {}],
      ['reload', {}],
      ['frames', {}],
    ] as const)
      await call(method, params);
    expect(executor.execute).toHaveBeenCalledTimes(15);
    for (const [method, params] of [
      ['click', { x: 10 }],
      ['hover', {}],
      ['click', { ref: 'x', x: 1, y: 2 }],
      ['drag', { from: { ref: 'x' }, to: {} }],
      ['keypress', { key: 'a', modifiers: ['Unknown'] }],
      ['wait', { condition: 'text' }],
      ['wait', { condition: 'visible' }],
      ['wait', { condition: 'url' }],
      ['scroll', { direction: 'down', y: 3 }],
    ] as const)
      await rejects(call(method, params), 'BAD_PARAMS');
    expect(executor.execute).toHaveBeenCalledTimes(15);
  });
  it('serializes actions, coalesces in-flight retries, rejects changed request IDs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    executor.execute.mockImplementationOnce(async () => {
      await gate;
      return { clicked: true };
    });
    const a = call('click', { ref: 'a' }, { requestId: 'same' });
    const retry = call('click', { ref: 'a' }, { requestId: 'same' });
    const next = call('click', { ref: 'b' });
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1));
    await rejects(call('click', { ref: 'other' }, { requestId: 'same' }), 'REQUEST_ID_CONFLICT');
    release();
    expect(await a).toEqual({ clicked: true });
    expect(await retry).toEqual({ clicked: true, replayed: true });
    await next;
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });
  it('stop and dialog handling bypass a waiting command, and stop cancels queued actions', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    executor.execute.mockImplementationOnce(async () => {
      await gate;
      return {};
    });
    const active = call('wait', { condition: 'loaded' });
    const queued = call('click', { ref: 'a' });
    const rejected = rejects(queued, 'STOPPED');
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1));
    await call('dialog', { action: 'dismiss' });
    await expect(call('describe', { method: 'wait' })).resolves.toHaveProperty('tools');
    await call('stop');
    expect(executor.execute).toHaveBeenCalledTimes(3);
    release();
    await active;
    await rejected;
    expect(executor.execute).toHaveBeenCalledTimes(3);
  });
});
