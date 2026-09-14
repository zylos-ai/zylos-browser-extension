// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executor = vi.hoisted(() => ({
  attach: vi.fn(),
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
  executor.attach.mockImplementation(async () => {
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
  });

  it('open with no task creates the task tab beside the active tab, then navigates the task tab', async () => {
    const first = (await call('open', { url: 'https://example.com/' })) as {
      started: boolean;
      tabId: number;
    };
    expect(first.started).toBe(true);
    expect(first.tabId).toBe(7);
    expect(executor.attach).toHaveBeenCalledWith(3, 'new', {
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
