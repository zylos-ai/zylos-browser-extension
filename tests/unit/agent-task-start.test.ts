import { afterEach, expect, it, vi } from 'vitest';
import {
  TaskStartLedger,
  captureStartTab,
  currentTabRefusal,
  taskStartSchema,
  waitForTaskPage,
} from '../../utils/agent-task-start';

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

const currentTab = {
  requestId: '11111111-1111-4111-8111-111111111111',
  prompt: 'Finish the form I filled in',
  target: 'current-tab',
};
it('accepts exactly one target: a URL or the current tab', () => {
  expect(taskStartSchema.parse(currentTab)).toEqual(currentTab);
  expect(taskStartSchema.parse(input)).toEqual(input);
  for (const changed of [
    { target: 'tab' },
    { target: '' },
    { url: input.url },
    { tabId: 3 },
    { prompt: ' ' },
  ])
    expect(taskStartSchema.safeParse({ ...currentTab, ...changed }).success).toBe(false);
  const { url: _url, ...noTarget } = input;
  expect(taskStartSchema.safeParse(noTarget).success).toBe(false);
});
it('treats a URL start and a current-tab start under one request ID as a conflict', async () => {
  const ledger = new TaskStartLedger();
  const work = vi.fn(async () => ({
    requestId: input.requestId,
    taskId: 'task',
    status: 'started' as const,
  }));
  await ledger.run(currentTab as never, work);
  expect(await ledger.run(currentTab as never, work)).toMatchObject({ status: 'existing' });
  await expect(ledger.run(input, work)).rejects.toMatchObject({ code: 'TASK_START_CONFLICT' });
  expect(work).toHaveBeenCalledTimes(1);
});

const userTab = {
  id: 7,
  windowId: 1,
  status: 'complete',
  url: 'https://example.com/upload',
  title: 'Upload',
} as chrome.tabs.Tab;
it.each([
  [undefined, 'TASK_START_NO_TAB'],
  [{ ...userTab, id: undefined }, 'TASK_START_NO_TAB'],
  [{ ...userTab, url: 'chrome://settings/' }, 'TASK_START_PAGE_RESTRICTED'],
  [{ ...userTab, url: 'https://chromewebstore.google.com/detail/x' }, 'TASK_START_PAGE_RESTRICTED'],
  [{ ...userTab, url: 'file:///tmp/a.html' }, 'TASK_START_PAGE_RESTRICTED'],
  [{ ...userTab, incognito: true }, 'TASK_START_PAGE_RESTRICTED'],
  [{ ...userTab, pendingUrl: 'https://example.com/next' }, 'TASK_START_PAGE_NOT_READY'],
  [{ ...userTab, url: 'https://www.paypal.com/myaccount' }, 'TASK_START_SITE_DENIED'],
  [{ ...userTab, url: 'https://example.com/delete-account' }, 'TASK_START_SITE_DENIED'],
  [userTab, undefined],
])('current-tab refusal for %j is %s', (tab, expected) => {
  expect(currentTabRefusal(tab as chrome.tabs.Tab | undefined)).toBe(expected);
});

const captured = { context: { contextId: 'ctx', tabId: 7 }, page: { title: 'Upload' } };
it('pins the active tab after capture without opening or following another tab', async () => {
  const get = vi.fn().mockResolvedValue(userTab);
  const create = vi.fn();
  vi.stubGlobal('chrome', { tabs: { get, create } });
  const capture = vi.fn().mockResolvedValue(captured);
  expect(await captureStartTab(userTab, 1, () => {}, capture)).toBe(captured);
  expect(capture).toHaveBeenCalledWith(7);
  expect(get).toHaveBeenCalledWith(7);
  expect(create).not.toHaveBeenCalled();
});
it.each([
  [{ ...userTab, url: 'chrome://newtab/' }, 'TASK_START_PAGE_RESTRICTED'],
  [{ ...userTab, url: 'https://www.paypal.com/' }, 'TASK_START_SITE_DENIED'],
  [undefined, 'TASK_START_NO_TAB'],
])('refuses %j before capture with %s', async (tab, code) => {
  const create = vi.fn();
  vi.stubGlobal('chrome', { tabs: { get: vi.fn(), create } });
  const capture = vi.fn();
  await expect(
    captureStartTab(tab as chrome.tabs.Tab | undefined, 1, () => {}, capture),
  ).rejects.toMatchObject({ code });
  expect(capture).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each([
  ['closed', null, captured, 'TASK_START_TAB_CLOSED'],
  [
    'navigated',
    { ...userTab, url: 'https://example.com/other' },
    captured,
    'TASK_START_PAGE_CHANGED',
  ],
  [
    'navigating',
    { ...userTab, pendingUrl: 'https://example.com/other' },
    captured,
    'TASK_START_PAGE_CHANGED',
  ],
  ['moved', { ...userTab, windowId: 2 }, captured, 'TASK_START_PAGE_CHANGED'],
  [
    'reloaded',
    userTab,
    { context: { tabId: 7, reason: 'PAGE_CHANGED' } },
    'TASK_START_PAGE_CHANGED',
  ],
  [
    'unreadable',
    userTab,
    { context: { tabId: 7, reason: 'CONTENT_UNAVAILABLE' } },
    'TASK_START_PAGE_NOT_READY',
  ],
])('refuses a tab %s during the start', async (_name, fresh, result, code) => {
  vi.stubGlobal('chrome', { tabs: { get: vi.fn().mockResolvedValue(fresh), create: vi.fn() } });
  await expect(
    captureStartTab(userTab, 1, () => {}, vi.fn().mockResolvedValue(result)),
  ).rejects.toMatchObject({ code });
});
it('Stop during capture wins over the start', async () => {
  vi.stubGlobal('chrome', { tabs: { get: vi.fn().mockResolvedValue(userTab) } });
  let stopped = false;
  const capture = vi.fn(async () => {
    stopped = true;
    return captured;
  });
  await expect(
    captureStartTab(
      userTab,
      1,
      () => {
        if (stopped) throw new Error('TASK_START_REVOKED');
      },
      capture,
    ),
  ).rejects.toThrow('TASK_START_REVOKED');
});
