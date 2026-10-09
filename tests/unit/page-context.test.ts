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
import type { PageSelection } from '../../utils/page-selection';
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
  expect(message.context).toMatchObject({
    contextId: id,
    tabId: 7,
    status: 'overview',
    contentVersion: '12-abc',
  });
  expect(message.context).not.toHaveProperty('text');
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

test('validates displayed quotes without copying them into the page context', async () => {
  const selection: PageSelection = {
    tabId: 7,
    documentId,
    url: tab.url!,
    title: 'Article',
    text: 'The exact selected passage',
    truncated: false,
  };
  const captured = await captureCurrentPage(id, 2, 7, [selection]);
  expect(captured.context).toMatchObject({ contextId: id, status: 'overview' });
  expect(captured.context).not.toHaveProperty('selection');
  expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  expect(chrome.debugger.attach).not.toHaveBeenCalled();
  await expect(captureCurrentPage(id, 2, 7, [{ ...selection, tabId: 99 }])).rejects.toThrow(
    'selectionChanged',
  );
  documentId = 'new-document';
  await expect(captureCurrentPage(id, 2, 7, [selection])).rejects.toThrow('selectionChanged');
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
  expect((await captureCurrentPage(id, 2, 7)).context).toMatchObject({
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
  expect((await captureCurrentPage(id, 2, 7)).context.contextId).toBeUndefined();
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
  expect((await captureCurrentPage(id, 2, 7)).context.status).toBe('unavailable');
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

test('the optional pre-send excerpt has a UI budget and cannot return late content', async () => {
  vi.useFakeTimers();
  const target = await getPageDocument(tab);
  let complete!: (value: any) => void;
  vi.mocked(chrome.scripting.executeScript).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = expect(readPageDocument(target, {}, () => {}, 2500)).rejects.toMatchObject({
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

test.each(['complete', 'stop'])(
  'an Agent page read waits without a deadline until %s',
  async (outcome) => {
    await captureCurrentPage(id, 2, 7);
    vi.useFakeTimers();
    let complete!: (value: any) => void;
    vi.mocked(chrome.scripting.executeScript).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    let stopped = false;
    let settled = false;
    const read = readPageContext(id, {}, () => {
      if (stopped) throw Object.assign(new Error('Stopped'), { code: 'STOPPED' });
    });
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    if (outcome === 'stop') {
      const rejected = expect(read).rejects.toMatchObject({ code: 'STOPPED' });
      stopped = true;
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
    }
    complete([{ documentId, frameId: 0, result: page() }]);
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === 'complete') await expect(read).resolves.toMatchObject({ text: 'Article body' });
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('sends a viewport and heading outline instead of leading page text', async () => {
  const viewport = {
    text: '- heading "Shipping"\n- StaticText "Shipped on Oct 3"',
    truncated: false,
    limited: false,
    width: 1280,
    height: 800,
    scrollX: 0,
    scrollY: 2400,
    contentHeight: 9000,
    remainingBelow: 5800,
  };
  const outline = [
    { level: 1, name: 'Order', offset: 0, position: 'above' },
    { level: 2, name: 'Items', offset: 812, position: 'above' },
    { level: 2, name: 'Shipping', offset: 2450, position: 'in-view' },
    { level: 3, name: 'Untraceable', position: 'below' },
  ];
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => [
    { documentId, frameId: 0, result: { ...page(), textLength: 9000, viewport, outline } },
  ]);
  const { context } = await captureCurrentPage(id, 2, 7);
  expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
    expect.objectContaining({ args: [{ limit: 1, overview: true }] }),
  );
  expect(context).toMatchObject({ contentVersion: '12-abc', textLength: 9000, viewport });
  expect(context.outline!.text.split('\n')).toEqual([
    '- h1 "Order" @0',
    '- h2 "Items" @812 [current section]',
    '- h2 "Shipping" @2450 [in view]',
    '- h3 "Untraceable"',
  ]);
  for (const key of ['text', 'links', 'nextOffset']) expect(context).not.toHaveProperty(key);
});

test('budget drops deep outline headings, then the outline tail, before the viewport', async () => {
  const line = (i: number) => `- StaticText "visible line ${i} ${'v'.repeat(70)}"`;
  const viewport = {
    text: Array.from({ length: 60 }, (_, i) => line(i)).join('\n'),
    truncated: false,
    limited: false,
    width: 1280,
    height: 800,
    scrollX: 0,
    scrollY: 0,
    contentHeight: 800,
    remainingBelow: 0,
  };
  const outline = Array.from({ length: 200 }, (_, i) => ({
    level: (i % 3) + 1,
    name: `Section ${i} ${'s'.repeat(80)}`,
    offset: i * 100,
    position: 'below',
  }));
  const capture = async (view: typeof viewport) => {
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => [
      { documentId, frameId: 0, result: { ...page(), viewport: view, outline } },
    ]);
    return (await captureCurrentPage(id, 2, 7)).context;
  };
  const context = await capture(viewport);
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(16000);
  expect(context.viewport).toEqual(viewport);
  expect(context.outline!.truncated).toBe(true);
  expect(context.outline!.text).not.toContain('- h3');
  expect(context.outline!.text.split('\n').every((l) => l.endsWith('"') || /@\d+$/.test(l))).toBe(
    true,
  );

  // A viewport larger than the whole budget is cut at a line boundary.
  const huge = await capture({ ...viewport, text: [1, 2, 3].map(() => viewport.text).join('\n') });
  expect(JSON.stringify(huge).length).toBeLessThanOrEqual(16000);
  expect(huge.outline!.text).toBe('');
  expect(huge.viewport!.truncated).toBe(true);
  expect(huge.viewport!.text.split('\n').every((l) => l.endsWith('"'))).toBe(true);
});

test('Agent read-page requests cannot ask for a viewport digest', async () => {
  await captureCurrentPage(id, 2, 7);
  await readPageContext(id, { offset: 0, viewport: true } as never, () => {});
  expect(chrome.scripting.executeScript).toHaveBeenLastCalledWith(
    expect.objectContaining({ args: [{ offset: 0, limit: undefined, contentVersion: undefined }] }),
  );
});
