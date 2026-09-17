// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { excerptFromAX, readPageExcerpt } from '../../utils/automation/page-context';

const executor = vi.hoisted(() => ({ capturePageExcerpt: vi.fn(), useExistingTab: vi.fn() }));
vi.mock('../../utils/automation/executor', () => executor);
import { captureCurrentPage, clearPageContexts, usePageContext } from '../../utils/page-context';
const id = '11111111-1111-4111-8111-111111111111';
const tab = {
  id: 7,
  windowId: 2,
  url: 'https://example.com/article',
  title: 'Article',
  incognito: false,
} as chrome.tabs.Tab;
beforeEach(() => {
  clearPageContexts();
  vi.clearAllMocks();
  executor.capturePageExcerpt.mockResolvedValue({
    text: 'heading: Article\nStaticText: Body',
    truncated: false,
    loaderId: 'document-1',
  });
  executor.useExistingTab.mockImplementation(async (context) => ({ tabId: context.tabId }));
  vi.stubGlobal('chrome', {
    windows: {
      get: vi.fn(async () => ({ id: 2 })),
      getLastFocused: vi.fn(async () => ({ id: 2 })),
    },
    tabs: { query: vi.fn(async () => [tab]), get: vi.fn(async () => tab) },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target, method) =>
        method === 'Page.getFrameTree'
          ? { frameTree: { frame: { id: 'root', url: tab.url, loaderId: 'document-1' } } }
          : {
              nodes: [
                { nodeId: 'body', role: { value: 'StaticText' }, name: { value: 'Article body' } },
              ],
            },
      ),
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('each message receives page content and a pinned token; later focus does not retarget it', async () => {
  const message = await captureCurrentPage(id, 2, 7);
  expect(JSON.parse(message.context)).toMatchObject({
    contextId: id,
    tabId: 7,
    text: expect.stringContaining('Body'),
  });
  vi.mocked(
    chrome.tabs.query as (query: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>,
  ).mockResolvedValue([{ ...tab, id: 99 }]);
  await usePageContext(id, () => {});
  expect(executor.useExistingTab).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: 7, windowId: 2, loaderId: 'document-1' }),
    expect.any(Function),
  );
  await expect(usePageContext('invented', () => {})).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  clearPageContexts();
  await expect(usePageContext(id, () => {})).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

test('contexts expire and a stop during capture does not revive a target', async () => {
  vi.useFakeTimers();
  await captureCurrentPage(id, 2, 7);
  vi.setSystemTime(Date.now() + 31 * 60_000);
  await expect(usePageContext(id, () => {})).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  executor.capturePageExcerpt.mockImplementationOnce(async () => {
    clearPageContexts();
    return { text: 'late', truncated: false };
  });
  expect(JSON.parse((await captureCurrentPage(id, 2, 7)).context).status).toBe('unavailable');
  await expect(usePageContext(id, () => {})).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

test('failed reads keep metadata and chat usable; restricted or changed pages cannot be selected', async () => {
  executor.capturePageExcerpt.mockRejectedValueOnce(new Error('DevTools attached'));
  expect(JSON.parse((await captureCurrentPage(id, 2, 7)).context)).toMatchObject({
    tabId: 7,
    status: 'unavailable',
    reason: 'CONTENT_UNAVAILABLE',
  });
  clearPageContexts();
  executor.capturePageExcerpt.mockRejectedValueOnce(new Error('PAGE_CHANGED'));
  await captureCurrentPage(id, 2, 7);
  await expect(usePageContext(id, () => {})).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  vi.mocked(chrome.tabs.get as (id: number) => Promise<chrome.tabs.Tab>).mockResolvedValueOnce({
    ...tab,
    url: 'https://example.com/checkout',
  });
  expect(JSON.parse((await captureCurrentPage(id, 2, 7)).context).contextId).toBeUndefined();
});

test('automatic excerpt omits editable values and descendants and remains bounded', () => {
  const result = excerptFromAX([
    { nodeId: 'heading', role: { value: 'heading' }, name: { value: 'Visible article' } },
    {
      nodeId: 'otp',
      role: { value: 'textbox' },
      name: { value: 'OTP' },
      value: { value: '123456' },
      childIds: ['secret'],
    },
    { nodeId: 'secret', role: { value: 'StaticText' }, name: { value: '123456' } },
    { nodeId: 'long', role: { value: 'StaticText' }, name: { value: 'a'.repeat(7000) } },
  ]);
  expect(result.text).toContain('Visible article');
  expect(result.text).not.toContain('123456');
  expect(result.truncated).toBe(true);
  expect(result.text.length).toBeLessThanOrEqual(6000);
});

test('a temporary debugger attachment is released; an existing executor attachment is retained', async () => {
  expect(await readPageExcerpt({ ...tab, id: 7 }, false)).toMatchObject({
    text: 'StaticText: Article body',
    loaderId: 'document-1',
  });
  expect(chrome.debugger.detach).toHaveBeenCalledOnce();
  vi.mocked(chrome.debugger.detach).mockClear();
  await readPageExcerpt({ ...tab, id: 7 }, true);
  expect(chrome.debugger.detach).not.toHaveBeenCalled();
});

test('navigation while reading discards the excerpt and late attachments are cleaned up after timeout', async () => {
  vi.mocked(chrome.tabs.get as (id: number) => Promise<chrome.tabs.Tab>).mockResolvedValueOnce({
    ...tab,
    url: 'https://example.com/new',
  });
  await expect(readPageExcerpt({ ...tab, id: 7 }, false)).rejects.toThrow('PAGE_CHANGED');
  vi.useFakeTimers();
  let finish!: () => void;
  vi.mocked(chrome.debugger.attach).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = expect(readPageExcerpt({ ...tab, id: 7 }, false)).rejects.toThrow(
    'CONTEXT_TIMEOUT',
  );
  await vi.advanceTimersByTimeAsync(2501);
  await pending;
  vi.mocked(chrome.debugger.detach).mockClear();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(chrome.debugger.detach).toHaveBeenCalledOnce();
});
