import { afterEach, expect, it, vi } from 'vitest';
import { TaskStartLedger, taskStartSchema, waitForTaskPage } from '../../utils/agent-task-start';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const readyTab = { id: 20, windowId: 1, status: 'complete', url: 'https://example.com/final' };
it('waits for the owned tab through loading and redirects before capture', async () => {
  vi.useFakeTimers();
  const get = vi
    .fn()
    .mockResolvedValueOnce({ ...readyTab, status: 'loading', pendingUrl: readyTab.url })
    .mockResolvedValue(readyTab);
  vi.stubGlobal('chrome', { tabs: { get } });
  const capture = vi
    .fn()
    .mockResolvedValueOnce({ context: {} })
    .mockResolvedValue({ context: { contextId: 'context' } });
  const waiting = waitForTaskPage(20, 1, () => {}, capture);
  await vi.advanceTimersByTimeAsync(0);
  expect(capture).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(await waiting).toEqual({ context: { contextId: 'context' } });
  expect(get.mock.calls.every(([id]) => id === 20)).toBe(true);
});

it.each([
  { ...readyTab, url: 'chrome://settings/' },
  { ...readyTab, url: 'https://chromewebstore.google.com/' },
])('does not capture restricted redirects: $url', async (tab) => {
  vi.stubGlobal('chrome', { tabs: { get: vi.fn().mockResolvedValue(tab) } });
  const capture = vi.fn();
  await expect(waitForTaskPage(20, 1, () => {}, capture)).rejects.toMatchObject({
    code: 'PAGE_UNAVAILABLE',
  });
  expect(capture).not.toHaveBeenCalled();
});

it('cancels without capture when stopped while the tab loads', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn().mockResolvedValue({ ...readyTab, status: 'loading' }) },
  });
  let stopped = false;
  const capture = vi.fn();
  const waiting = waitForTaskPage(
    20,
    1,
    () => {
      if (stopped) throw new Error('stopped');
    },
    capture,
  );
  const rejected = expect(waiting).rejects.toThrow('stopped');
  await vi.advanceTimersByTimeAsync(0);
  stopped = true;
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(capture).not.toHaveBeenCalled();
});

it('times out without starting another tab or capturing a loading page', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn().mockResolvedValue({ ...readyTab, status: 'loading' }) },
  });
  const capture = vi.fn();
  const waiting = waitForTaskPage(20, 1, () => {}, capture, 300);
  const rejected = expect(waiting).rejects.toMatchObject({ code: 'TASK_START_PAGE_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(300);
  await rejected;
  expect(capture).not.toHaveBeenCalled();
});

it.each([null, { ...readyTab, windowId: 2 }, { ...readyTab, incognito: true }])(
  'rejects a closed, moved or incognito target',
  async (tab) => {
    vi.stubGlobal('chrome', { tabs: { get: vi.fn().mockResolvedValue(tab) } });
    await expect(waitForTaskPage(20, 1, () => {}, vi.fn())).rejects.toMatchObject({
      code: 'TASK_START_REVOKED',
    });
  },
);

const input = {
  requestId: '11111111-1111-4111-8111-111111111111',
  prompt: 'Read page',
  url: 'https://example.com/',
};
it('reserves concurrent starts and retains completed task IDs', async () => {
  const ledger = new TaskStartLedger();
  const work = vi.fn(async () => ({
    requestId: input.requestId,
    taskId: 'task',
    status: 'started' as const,
  }));
  const first = ledger.run(input, work);
  const second = ledger.run(input, work);
  expect(await first).toMatchObject({ status: 'started' });
  expect(await second).toMatchObject({ status: 'existing' });
  await ledger.run(input, work);
  expect(work).toHaveBeenCalledTimes(1);
  await expect(ledger.run({ ...input, prompt: 'different' }, work)).rejects.toMatchObject({
    code: 'TASK_START_CONFLICT',
  });
});
it('retains failed uncertain starts without repeating effects', async () => {
  const ledger = new TaskStartLedger();
  const work = vi.fn(async () => {
    throw new Error('lost response');
  });
  await expect(ledger.run(input, work)).rejects.toThrow('lost response');
  await expect(ledger.run(input, work)).rejects.toThrow('lost response');
  expect(work).toHaveBeenCalledTimes(1);
});
it('fails closed when the bounded ledger is full', async () => {
  const ledger = new TaskStartLedger();
  const work = vi.fn(async () => ({
    requestId: input.requestId,
    taskId: 'task',
    status: 'started' as const,
  }));
  for (let i = 0; i < 256; i++) await ledger.run({ ...input, requestId: String(i) }, work);
  await expect(ledger.run(input, work)).rejects.toMatchObject({ code: 'TASK_START_CONFLICT' });
  expect(work).toHaveBeenCalledTimes(256);
});
it('rejects invalid IDs, unsafe URLs, unknown fields and oversized prompts', () => {
  expect(taskStartSchema.safeParse(input).success).toBe(true);
  for (const changed of [
    { requestId: 'short' },
    { prompt: ' ' },
    { prompt: 'x'.repeat(8001) },
    { url: 'file:///tmp/a' },
    { url: 'https://user:pass@example.com' },
    { tabId: 123 },
  ])
    expect(taskStartSchema.safeParse({ ...input, ...changed }).success).toBe(false);
});
