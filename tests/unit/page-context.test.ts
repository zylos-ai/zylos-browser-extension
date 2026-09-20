// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const executor = vi.hoisted(() => ({ useExistingTab: vi.fn() }));
vi.mock('../../utils/automation/executor', () => executor);
import {
  captureCurrentPage,
  clearPageContexts,
  readPageContext,
  usePageContext,
} from '../../utils/page-context';
import { getPageDocument, readPageDocument } from '../../utils/page-reader';
const id = '11111111-1111-4111-8111-111111111111';
const tab = {
  id: 7,
  windowId: 2,
  url: 'https://example.com/article',
  title: 'Article',
  incognito: false,
} as chrome.tabs.Tab & { id: number };
let documentId: string;
const page = () => ({
  url: tab.url!,
  title: 'Article',
  text: 'Article body',
  links: [],
  contentVersion: '12-abc',
  nextOffset: null,
  offset: 0,
  truncated: false,
  limited: false,
});
beforeEach(() => {
  clearPageContexts();
  vi.clearAllMocks();
  documentId = 'document-1';
  executor.useExistingTab.mockImplementation(async (context) => ({ tabId: context.tabId }));
  vi.stubGlobal('chrome', {
    windows: {
      get: vi.fn(async () => ({ id: 2 })),
      getLastFocused: vi.fn(async () => ({ id: 2 })),
    },
    tabs: { query: vi.fn(async () => [tab]), get: vi.fn(async () => tab) },
    webNavigation: { getFrame: vi.fn(async () => ({ documentId, url: tab.url })) },
    scripting: { executeScript: vi.fn(async () => [{ documentId, frameId: 0, result: page() }]) },
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('captures DOM text without CDP and pins reads/operations despite foreground changes', async () => {
  const message = await captureCurrentPage(id, 2, 7);
  expect(JSON.parse(message.context)).toMatchObject({
    contextId: id,
    tabId: 7,
    text: 'Article body',
  });
  vi.mocked(
    chrome.tabs.query as (query: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>,
  ).mockResolvedValue([{ ...tab, id: 99 }]);
  await readPageContext(id, {}, () => {});
  expect(chrome.scripting.executeScript).toHaveBeenLastCalledWith(
    expect.objectContaining({
      target: { tabId: 7, documentIds: ['document-1'] },
      world: 'ISOLATED',
    }),
  );
  expect(chrome.debugger.attach).not.toHaveBeenCalled();
  expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
  await usePageContext(id, () => {});
  expect(executor.useExistingTab).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: 7, documentId: 'document-1' }),
    expect.any(Function),
  );
});

test('same-URL reload and closed tabs cannot be read through an old context', async () => {
  await captureCurrentPage(id, 2, 7);
  documentId = 'document-2';
  await expect(readPageContext(id, {}, () => {})).rejects.toMatchObject({ code: 'PAGE_CHANGED' });
  expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  vi.mocked(chrome.tabs.get as (id: number) => Promise<chrome.tabs.Tab>).mockRejectedValue(
    new Error('Closed'),
  );
  await expect(readPageContext(id, {}, () => {})).rejects.toMatchObject({ code: 'PAGE_CHANGED' });
});

test('denied content access retains metadata and chat without falling back to CDP', async () => {
  vi.mocked(chrome.scripting.executeScript).mockRejectedValue(
    new Error('Cannot access contents of the page'),
  );
  expect(JSON.parse((await captureCurrentPage(id, 2, 7)).context)).toMatchObject({
    contextId: id,
    tabId: 7,
    status: 'unavailable',
    reason: 'CONTENT_UNAVAILABLE',
  });
  expect(chrome.debugger.attach).not.toHaveBeenCalled();
  expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
});

test('restricted pages do not receive an executable context or injected script', async () => {
  vi.mocked(chrome.tabs.get as (id: number) => Promise<chrome.tabs.Tab>).mockResolvedValue({
    ...tab,
    url: 'https://example.com/checkout',
  });
  expect(JSON.parse((await captureCurrentPage(id, 2, 7)).context).contextId).toBeUndefined();
  expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  await expect(readPageContext(id, {}, () => {})).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

test('context expiry and clearing during capture cannot revive a target', async () => {
  vi.useFakeTimers();
  await captureCurrentPage(id, 2, 7);
  vi.setSystemTime(Date.now() + 31 * 60_000);
  await expect(readPageContext(id, {}, () => {})).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  vi.mocked(chrome.scripting.executeScript).mockImplementationOnce(async () => {
    clearPageContexts();
    return [{ documentId, frameId: 0, result: page() }];
  });
  expect(JSON.parse((await captureCurrentPage(id, 2, 7)).context).status).toBe('unavailable');
  await expect(usePageContext(id, () => {})).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

test('navigation during a read discards its result', async () => {
  const target = await getPageDocument(tab);
  vi.mocked(chrome.scripting.executeScript).mockImplementationOnce(async () => {
    documentId = 'new-document';
    return [{ documentId: target.documentId, frameId: 0, result: page() }];
  });
  await expect(readPageDocument(target)).rejects.toMatchObject({ code: 'PAGE_CHANGED' });
});

test('pagination refuses to combine text from changed content versions', async () => {
  await captureCurrentPage(id, 2, 7);
  await expect(
    readPageContext(id, { offset: 6000, contentVersion: 'previous' }, () => {}),
  ).rejects.toMatchObject({ code: 'PAGE_CONTENT_CHANGED' });
  expect((await readPageContext(id, { offset: 0 }, () => {})).text).toBe('Article body');
});

test('slow reads time out and a stopped read cannot return late content', async () => {
  vi.useFakeTimers();
  const target = await getPageDocument(tab);
  let complete!: (value: any) => void;
  vi.mocked(chrome.scripting.executeScript).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = expect(readPageDocument(target)).rejects.toMatchObject({
    code: 'CONTEXT_TIMEOUT',
  });
  await vi.advanceTimersByTimeAsync(2501);
  await pending;
  complete([{ documentId, frameId: 0, result: page() }]);
  await vi.advanceTimersByTimeAsync(0);
  let stopped = false;
  vi.mocked(chrome.scripting.executeScript).mockImplementationOnce(async () => {
    stopped = true;
    return [{ documentId, frameId: 0, result: page() }];
  });
  await expect(
    readPageDocument(target, {}, () => {
      if (stopped) throw Object.assign(new Error('Stopped'), { code: 'STOPPED' });
    }),
  ).rejects.toMatchObject({ code: 'STOPPED' });
  expect(chrome.debugger.attach).not.toHaveBeenCalled();
});
