// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executor = vi.hoisted(() => ({
  createTask: vi.fn(),
  execute: vi.fn(),
  currentControl: vi.fn((): null | { sessionId: string; tabId: number; tabIds: number[] } => null),
  currentGrant: vi.fn((): null | { id: number; url: string } => null),
}));
vi.mock('../../utils/automation/executor', () => executor);
const context = vi.hoisted(() => ({ readPageContext: vi.fn(), usePageContext: vi.fn() }));
vi.mock('../../utils/page-context', () => context);

import { IdempotencyCache, BrowserActionError, dispatch } from '../../utils/browser-actions';

const call = (
  method: string,
  params: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => dispatch({ method, params, keyId: 'abcdef012345', ...extra }, idem);
const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BrowserActionError);
  expect((err as BrowserActionError).code).toBe(code);
  return err as BrowserActionError;
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

describe('local browser dispatch', () => {
  it('dispatches a DOM read without control or preview activation', async () => {
    context.readPageContext.mockResolvedValue({ text: 'article' });
    const onExecute = vi.fn();
    await expect(
      dispatch(
        {
          method: 'read-page',
          params: { contextId: '11111111-1111-4111-8111-111111111111' },
          keyId: 'endpoint',
        },
        idem,
        undefined,
        onExecute,
      ),
    ).resolves.toEqual({ text: 'article' });
    expect(context.readPageContext).toHaveBeenCalledOnce();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.createTask).not.toHaveBeenCalled();
    expect(onExecute).not.toHaveBeenCalled();
  });
  it('refuses unknown methods and bad params before touching the executor', async () => {
    await rejects(call('Runtime.evaluate', { expression: '1' }), 'UNKNOWN_METHOD');
    await rejects(call('click', {}), 'BAD_PARAMS');
    await rejects(call('click', { ref: 'e1', extra: true }), 'BAD_PARAMS');
    await rejects(call('open', { url: 'not a url' }), 'BAD_PARAMS');
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
  });

  it('refuses to start in an incognito or missing window', async () => {
    (chrome.windows.getLastFocused as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      incognito: true,
    });
    await rejects(call('open', { url: 'https://example.com/' }), 'NO_WINDOW');
  });

  it('maps browser actions to executor commands', async () => {
    await call('open', { url: 'https://example.com/' });
    await call('click', { ref: 'e12' });
    await call('scroll', { direction: 'down' });
    expect(executor.execute.mock.calls.map((c) => c[0])).toEqual([
      { op: 'click', ref: 'e12' },
      { op: 'scroll', direction: 'down', pixels: 500 },
    ]);
  });

  it('blocks navigation to blocklisted URLs and interaction while parked on one', async () => {
    const e = await rejects(call('open', { url: 'https://shop.example/checkout' }), 'BLOCKED_URL');
    expect(e.details).toEqual({ url: 'https://shop.example/checkout' });
    await call('open', { url: 'https://example.com/' });
    executor.currentGrant.mockReturnValue({ id: 7, url: 'https://www.chase.com/login' });
    await rejects(call('snapshot'), 'BLOCKED_URL');
    await rejects(call('click', { ref: 'e1' }), 'BLOCKED_URL');
    await rejects(call('observe'), 'BLOCKED_URL');
    // The way out stays open.
    await expect(call('open', { url: 'https://example.com/' })).resolves.toBeTruthy();
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

  it('honours the local action deadline', async () => {
    await rejects(call('tabs', {}, { deadline: Date.now() - 1 }), 'COMMAND_EXPIRED');
  });
});

describe('browser actions v2', () => {
  it('validates every new action before dispatch, using the shared browser contract', async () => {
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
      ['dialog', { action: 'accept', promptText: 'hello' }],
      ['back', {}],
      ['forward', {}],
      ['reload', {}],
      ['frames', {}],
    ] as const)
      await call(method, params);
    expect(executor.execute).toHaveBeenCalledTimes(14);
    for (const [method, params] of [
      ['click', { x: 10 }],
      ['hover', {}],
      ['click', { ref: 'x', x: 1, y: 2 }],
      ['drag', { from: { ref: 'x' }, to: {} }],
      ['keypress', { key: 'a', modifiers: ['Unknown'] }],
      ['scroll', { direction: 'down', y: 3 }],
    ] as const)
      await rejects(call(method, params), 'BAD_PARAMS');
    expect(executor.execute).toHaveBeenCalledTimes(14);
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
  it('dialog handling bypasses an action, and cancellation invalidates queued actions', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    executor.execute.mockImplementationOnce(async () => {
      await gate;
      return {};
    });
    const active = call('click', { ref: 'current' });
    const queued = call('click', { ref: 'a' });
    const rejected = rejects(queued, 'STOPPED');
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1));
    await call('dialog', { action: 'dismiss' });
    idem.cancel();
    expect(executor.execute).toHaveBeenCalledTimes(2);
    release();
    await active;
    await rejected;
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });
});
