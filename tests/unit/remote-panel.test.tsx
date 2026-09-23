import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LanguageProvider } from '../../components/LanguageProvider';
import { RemotePanel } from '../../components/RemotePanel';
import { initialRemoteState, type RemoteState } from '../../utils/remote';
import markdownExample from '../fixtures/markdown-message.json';
import { selectionAttachment } from '../../utils/attachments';
import { formatTaskNotice } from '../../utils/task-notice';

let root: Root;
let container: HTMLDivElement;
let state: RemoteState;
let send: ReturnType<typeof vi.fn>;
let listener: (message: unknown) => void;
let previewListener: (message: unknown) => void;
let previewDisconnect: () => void;
let previewPost: ReturnType<typeof vi.fn>;
let queryTabs: ReturnType<typeof vi.fn<() => Promise<chrome.tabs.Tab[]>>>;
let savedPreferences: Record<string, unknown>;
const input = () => container.querySelector<HTMLTextAreaElement>('#message')!;
async function click(selector: string) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(selector)!.click();
  });
}
async function enter(options: KeyboardEventInit = {}) {
  await act(async () => {
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options }),
    );
  });
}
async function fill(selector: string, value: string) {
  await act(async () => {
    const el = container.querySelector(selector)!;
    const prototype =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function mount() {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <RemotePanel />
      </LanguageProvider>,
    );
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state = {
    ...initialRemoteState,
    configured: true,
    connected: true,
    relayUrl: 'ws://localhost:3802/ext',
    chat: [],
  };
  send = vi.fn(async () => ({ ok: true, value: state }));
  savedPreferences = {};
  previewPost = vi.fn();
  queryTabs = vi.fn(async () => [
    {
      id: 3,
      windowId: 1,
      url: 'https://example.com/',
      title: 'Example',
      favIconUrl: 'https://example.com/favicon.ico',
    } as chrome.tabs.Tab,
  ]);
  vi.stubGlobal('chrome', {
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    tabs: {
      query: queryTabs,
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    i18n: { getUILanguage: () => 'zh-CN' },
    storage: {
      local: {
        get: vi.fn(async () => ({ ...savedPreferences })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(savedPreferences, value);
        }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      sendMessage: send,
      connect: vi.fn(() => ({
        postMessage: previewPost,
        disconnect: vi.fn(),
        onMessage: {
          addListener: (fn: typeof previewListener) => {
            previewListener = fn;
          },
        },
        onDisconnect: {
          addListener: (fn: typeof previewDisconnect) => {
            previewDisconnect = fn;
          },
        },
      })),
      onMessage: {
        addListener: (fn: typeof listener) => {
          listener = fn;
        },
        removeListener: vi.fn(),
      },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

test('saved and live Agent replies render Markdown while user messages retain their literal text', async () => {
  state.chat = [
    { role: 'user', text: '# Keep **this** literal', ts: 1 },
    { role: 'assistant', text: markdownExample.text, ts: 2, final: true },
  ];
  await mount();
  const reply = container.querySelector('.message.assistant .markdown-body')!;
  expect(reply.querySelector('h1')?.textContent).toBe('页面调研报告');
  expect(reply.querySelector('strong')?.textContent).toBe('结论：');
  expect(reply.querySelector('em')?.textContent).toBe('价格并非唯一因素');
  expect(reply.querySelector('blockquote')?.textContent).toContain('安装方便');
  expect(reply.querySelector('ol > li')?.textContent).toContain('核实原始来源');
  expect(reply.querySelectorAll('table tbody tr')).toHaveLength(2);
  expect(reply.querySelectorAll('table th')).toHaveLength(4);
  expect(reply.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked).toBe(true);
  expect(reply.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(true);
  expect(reply.querySelector('del')?.textContent).toBe('未经核实的说法');
  expect(reply.querySelector('pre code')?.textContent).toContain(
    'const result = await browser.snapshot',
  );
  const source = reply.querySelector<HTMLAnchorElement>('a[href^="https:"]')!;
  expect(source.href).toBe('https://example.com/report?source=browser&view=full');
  expect(source.target).toBe('_blank');
  expect(source.rel).toBe('noopener noreferrer');
  expect(container.querySelector('.message.user')?.textContent).toBe('# Keep **this** literal');
  expect(container.querySelector('.message.user h1')).toBeNull();
  state.chat.push({
    role: 'assistant',
    text: '## 继续整理\n\n已完成 **两项**。',
    ts: 3,
    final: false,
  });
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelectorAll('.markdown-body h2')[0]?.textContent).toBe('主要发现');
  expect([...container.querySelectorAll('.markdown-body h2')].at(-1)?.textContent).toBe('继续整理');
});

test('Markdown cannot inject HTML or executable URLs, and footnotes stay within each message', async () => {
  const text = [
    '<script>window.injected = true</script>',
    '',
    '<img src="https://example.com/tracker" onerror="window.injected=true">',
    '',
    '[unsafe](javascript:alert%281%29)',
    '',
    '[encoded](jav&#x61;script:alert%281%29)',
    '',
    '[relative](/settings)',
    '',
    '[file](file:///tmp/file)',
    '',
    '![blocked](data:image/png;base64,AAAA)',
    '',
    '```html',
    '<img onerror="alert(1)">',
    '```',
    '',
    'Note[^one]',
    '',
    '[^one]: A footnote.',
  ].join('\n');
  state.chat = [
    { role: 'assistant', text, ts: 1 },
    { role: 'assistant', text, ts: 2 },
  ];
  await mount();
  expect(container.querySelector('.markdown-body :is(script, img, iframe, [onerror])')).toBeNull();
  expect(
    container.querySelector('a[href^="javascript:"], a[href^="file:"], a[href="/settings"]'),
  ).toBeNull();
  expect(container.querySelector('pre code')?.textContent).toContain('<img onerror="alert(1)">');
  const references = [...container.querySelectorAll<HTMLAnchorElement>('a[data-footnote-ref]')];
  expect(references).toHaveLength(2);
  expect(references[0]!.getAttribute('href')).not.toBe(references[1]!.getAttribute('href'));
  for (const link of references) {
    const target = document.getElementById(link.getAttribute('href')!.slice(1));
    expect(target?.closest('.markdown-body')).toBe(link.closest('.markdown-body'));
    expect(link.target).toBe('');
  }
});

test('starter prompts fill the composer and require a separate send; IME and Shift+Enter do not send', async () => {
  await mount();
  expect(container.querySelector('.current-page')).toBeNull();
  expect(container.querySelector('.selection-chip')).toBeNull();
  send.mockClear();
  await click('.starter');
  expect(input().value).toBe('把当前页面这篇文章总结成 5 个要点');
  expect(document.activeElement).toBe(input());
  expect(send).not.toHaveBeenCalled();
  await enter({ shiftKey: true });
  await enter({ isComposing: true });
  await enter({ keyCode: 229 });
  expect(send).not.toHaveBeenCalled();
  await enter();
  expect(send).toHaveBeenCalledExactlyOnceWith({
    type: 'remote-chat-send',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '把当前页面这篇文章总结成 5 个要点' }],
    },
    windowId: 1,
    tabId: 3,
  });
  expect(input().value).toBe('');
});

test('selected text appears above the composer, survives focus and failed send, and is consumed once', async () => {
  vi.useFakeTimers();
  let text = 'Quoted passage\nSecond line';
  Object.assign(chrome, {
    scripting: {
      executeScript: vi.fn(async () => [
        {
          frameId: 0,
          documentId: 'doc-1',
          result: { url: 'https://example.com/', text, truncated: false },
        },
      ]),
    },
  });
  await mount();
  expect(container.querySelector('.current-page')).toBeNull();
  const trigger = container.querySelector<HTMLButtonElement>('.selection-chip-label')!;
  const tooltip = container.querySelector<HTMLElement>('.selection-tooltip')!;
  expect(trigger.textContent).toBe('');
  expect(trigger.getAttribute('aria-label')).toContain('Example');
  const icon = trigger.querySelector('img')!;
  expect(icon.getAttribute('src')).toBe('https://example.com/favicon.ico');
  await act(async () => icon.dispatchEvent(new Event('error')));
  expect(trigger.querySelector('img')).toBeNull();
  expect(trigger.querySelector('svg')).not.toBeNull();
  expect(tooltip.hidden).toBe(true);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  expect(tooltip.hidden).toBe(false);
  expect(tooltip.textContent).toContain(text);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  });
  expect(tooltip.hidden).toBe(true);
  await act(async () => trigger.focus());
  expect(tooltip.hidden).toBe(false);
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(tooltip.hidden).toBe(true);
  expect(container.querySelector('.composer-field .selection-quote')?.textContent).toContain(text);
  await act(async () => input().focus());
  await fill('#message', 'Explain this selection');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(601);
  });
  expect(container.querySelector('.composer-field .selection-quote')?.textContent).toContain(
    'Quoted passage',
  );
  send.mockResolvedValueOnce({ ok: false, error: 'ui.error.sendFailed' });
  await enter();
  expect(input().value).toBe('Explain this selection');
  expect(container.querySelector('.selection-quote')).not.toBeNull();
  text = 'Quoted passage\nSecond line';
  await enter();
  expect(send).toHaveBeenLastCalledWith({
    type: 'remote-chat-send',
    windowId: 1,
    tabId: 3,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'Explain this selection' },
        {
          id: expect.any(String),
          type: 'quote',
          text,
          truncated: false,
          source: {
            tabId: 3,
            documentId: 'doc-1',
            url: 'https://example.com/',
            title: 'Example',
          },
        },
      ],
    },
  });
  expect(input().value).toBe('');
  expect(container.querySelector('.composer-field .selection-quote')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1201);
  });
  expect(container.querySelector('.composer-field .selection-quote')).toBeNull();
});

test('cancelling or removing a quote prevents sending it, and history shows only the user message', async () => {
  vi.useFakeTimers();
  let text = 'First selection';
  Object.assign(chrome, {
    scripting: {
      executeScript: vi.fn(async () => [
        {
          frameId: 0,
          documentId: 'doc-1',
          result: { url: 'https://example.com/', text, truncated: false },
        },
      ]),
    },
  });
  await mount();
  text = '';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(601);
  });
  expect(container.querySelector('.selection-chip')).toBeNull();
  await fill('#message', 'Selection cancelled');
  await enter();
  expect(send).toHaveBeenLastCalledWith({
    type: 'remote-chat-send',
    message: { role: 'user', content: [{ type: 'text', text: 'Selection cancelled' }] },
    windowId: 1,
    tabId: 3,
  });
  text = 'First selection';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(601);
  });
  expect(container.querySelector('.selection-chip')).not.toBeNull();
  await click('.selection-quote-remove');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1201);
  });
  expect(container.querySelector('.selection-quote')).toBeNull();
  await fill('#message', 'No quote');
  await enter();
  expect(send).toHaveBeenLastCalledWith({
    type: 'remote-chat-send',
    message: { role: 'user', content: [{ type: 'text', text: 'No quote' }] },
    windowId: 1,
    tabId: 3,
  });
  text = '<img src=x onerror=alert(1)> **New selection**';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(601);
  });
  expect(container.querySelector('.selection-quote blockquote')?.textContent).toBe(text);
  state.chat.push({
    role: 'user',
    text: 'Explain',
    ts: 1,
    page: { url: 'https://example.com/', title: 'Example', status: 'excerpt' },
    attachments: [
      selectionAttachment({
        text,
        truncated: false,
        tabId: 3,
        documentId: 'doc-1',
        url: 'https://example.com/',
        title: 'Example',
      }),
    ],
  });
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelector('.message.user')?.textContent).toBe('Explain');
  expect(container.querySelector('.message.user .selection-quote')).toBeNull();
  expect(container.querySelector('.message.user .message-page')).toBeNull();
  expect(container.querySelector('.selection-quote img')).toBeNull();
  expect(container.querySelector('.message.user .selection-quote-remove')).toBeNull();
});

test('same-URL reload and switching tabs clear the old quote, and hidden panels stop selection reads', async () => {
  vi.useFakeTimers();
  let documentId = 'doc-1',
    text = 'Old quote';
  const reading = vi.fn(async () => [
    { frameId: 0, documentId, result: { url: 'https://example.com/', text, truncated: false } },
  ]);
  Object.assign(chrome, { scripting: { executeScript: reading } });
  await mount();
  documentId = 'doc-2';
  text = '';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(601);
  });
  expect(container.querySelector('.selection-quote')).toBeNull();
  text = 'New quote';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(601);
  });
  expect(container.querySelector('.selection-quote')?.textContent).toContain(text);
  vi.mocked(
    chrome.tabs.query as (query: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>,
  ).mockResolvedValue([{ id: 9, windowId: 1, url: 'https://other.example/' } as chrome.tabs.Tab]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(601);
  });
  expect(container.querySelector('.selection-quote')).toBeNull();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  const before = reading.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(reading).toHaveBeenCalledTimes(before);
});

test.each([{ loopActive: true }, { chatBusy: true }])(
  'busy task or initial capture replaces Send with Stop while Enter and submit preserve the draft: %j',
  async (busy) => {
    Object.assign(state, busy);
    await mount();
    await fill('#message', 'Next message draft');
    send.mockClear();
    expect(input().disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(false);
    expect(container.querySelector('#send')!.getAttribute('aria-label')).toBe('停止任务');
    await enter();
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('Next message draft');
    let stopped!: (value: unknown) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stopped = resolve;
        }),
    );
    await click('#send');
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'remote-stop' });
    expect(container.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
    expect(container.querySelector('#send')!.getAttribute('aria-label')).toBe('正在停止…');
    await click('#send');
    await enter();
    expect(send).toHaveBeenCalledTimes(1);
    state.loopActive = false;
    state.chatBusy = false;
    await act(async () => stopped({ ok: true, value: state }));
    expect(container.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(false);
    send.mockClear();
    expect(send).not.toHaveBeenCalled();
    await click('#send');
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: 'remote-chat-send',
      message: { role: 'user', content: [{ type: 'text', text: 'Next message draft' }] },
      windowId: 1,
      tabId: 3,
    });
  },
);

test('compact progress shows only a broad overview and collapses neutrally on completion', async () => {
  state.chat = [
    { id: 'question', role: 'user', text: '看看当前页面', ts: 1 },
    {
      id: 'tools-1',
      role: 'system',
      text: '',
      ts: 2,
      toolRun: {
        status: 'running',
        total: 2,
        failed: 0,
        startedAt: 2,
        steps: [
          {
            id: 's1',
            number: 1,
            method: 'snapshot',
            status: 'success',
            queuedAt: 2,
            startedAt: 3,
            endedAt: 203,
          },
          {
            id: 's2',
            number: 2,
            method: 'click',
            status: 'running',
            queuedAt: 204,
            startedAt: 205,
          },
        ],
      },
    },
  ];
  await mount();
  const toggle = () => container.querySelector<HTMLButtonElement>('.tool-activity-toggle')!;
  const body = () => container.querySelector<HTMLElement>('.tool-activity-body')!;
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(body().hidden).toBe(true);
  expect(toggle().textContent).toContain('正在操作页面');
  await click('.tool-activity-toggle');
  expect(body().hidden).toBe(false);
  expect(container.querySelector('.message-list .tool-activity')).not.toBeNull();
  expect(body().textContent).toContain('读取页面内容');
  expect(body().textContent).toContain('操作页面');
  expect(container.querySelector('.tool-diagnostics')).toBeNull();
  expect(body().textContent).not.toMatch(/snapshot|click|成功|失败|执行中/);
  const run = state.chat[1]!.toolRun!;
  run.status = 'completed';
  run.endedAt = 1402;
  run.failed = 1;
  run.steps[1]!.status = 'error';
  run.steps[1]!.errorCode = 'STALE_REF';
  run.steps[1]!.endedAt = 1200;
  state.chat.push({ role: 'assistant', text: '已处理', ts: 1402, final: true });
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(body().hidden).toBe(true);
  expect(toggle().textContent).toBe('用时 0:01');
  await click('.tool-activity-toggle');
  expect(body().hidden).toBe(false);
  expect(container.querySelector('.tool-activity')?.textContent).not.toMatch(
    /STALE_REF|成功|异常|失败/,
  );
  expect(run.steps[1]!.errorCode).toBe('STALE_REF'); // Presentation keeps the original evidence intact.
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(body().hidden).toBe(false);
});

test('progress includes the initial waiting time, freezes at completion and preserves navigation order', async () => {
  vi.useFakeTimers();
  const start = Date.now();
  state.chat = [
    { role: 'user', text: 'Read pages', ts: start },
    {
      role: 'system',
      text: '',
      ts: start + 1000,
      toolRun: {
        status: 'running',
        total: 30,
        failed: 0,
        startedAt: start + 1000,
        steps: Array.from({ length: 30 }, (_, i) => ({
          id: `step-${i}`,
          number: i + 1,
          method: i % 2 ? 'back' : 'open',
          status: i === 29 ? 'running' : 'success',
          queuedAt: start + 1000,
        })),
      },
    },
  ];
  await mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(69_000);
  });
  expect(container.querySelector('.tool-activity-time')?.textContent).toBe('1:09');
  await click('.tool-activity-toggle');
  expect(container.querySelectorAll('.tool-overview li')).toHaveLength(30);
  expect(
    [...container.querySelectorAll('.tool-overview li')].slice(0, 2).map((el) => el.textContent),
  ).toEqual(['打开页面', '返回上一页']);
  const run = state.chat[1]!.toolRun!;
  run.status = 'completed';
  run.endedAt = start + 689_000;
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelector('.tool-activity-time')?.textContent).toBe('用时 11:29');
  expect(container.querySelector('.tool-activity-dot')).toBeNull();
  expect(container.querySelector<HTMLElement>('.tool-activity-body')?.hidden).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(container.querySelector('.tool-activity-time')?.textContent).toBe('用时 11:29');
});

test('Agent phase descriptions appear as plain text and tool states remain specific', async () => {
  state.chat = [
    { role: 'user', text: '看看后面的内容', ts: Date.now() },
    {
      role: 'system',
      text: '',
      ts: Date.now(),
      toolRun: {
        status: 'running',
        startedAt: Date.now(),
        total: 1,
        failed: 0,
        steps: [
          {
            id: 's1',
            number: 1,
            method: 'scroll',
            status: 'running',
            queuedAt: Date.now(),
            summary: '继续查看后面的应用，补齐下载量数据。 <b>原文</b>',
          },
        ],
      },
    },
  ];
  await mount();
  expect(container.querySelector('.tool-activity-title')?.textContent).toBe('正在滚动查看更多内容');
  expect(container.querySelector('.tool-activity-context')).toBeNull();
  await click('.tool-activity-toggle');
  expect(container.querySelector('.tool-overview')?.textContent).toContain('继续查看后面的应用');
  const run = state.chat[1]!.toolRun!;
  run.steps[0]!.status = 'success';
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelector('.tool-activity-title')?.textContent).toContain('补齐下载量');
  expect(container.querySelector('.tool-activity-title b')).toBeNull();
  run.status = 'completed';
  run.endedAt = Date.now();
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelector('.tool-activity-context')).toBeNull();
  await click('.tool-activity-toggle');
  expect(container.querySelector('.tool-overview')?.textContent).toContain('补齐下载量');
});

test('failed sends retain the draft; an in-flight send cannot erase the next message or submit twice', async () => {
  await mount();
  await fill('#message', '保留这条消息');
  send.mockResolvedValueOnce({ ok: false, error: '连接中断' });
  await enter();
  expect(input().value).toBe('保留这条消息');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('连接中断');
  let resolve!: (value: unknown) => void;
  send.mockClear().mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await enter();
  await enter();
  expect(send).toHaveBeenCalledTimes(1);
  await fill('#message', '接着输入的新消息');
  await act(async () => {
    resolve({ ok: true, value: state });
  });
  expect(input().value).toBe('接着输入的新消息');
});

test('Stop during tab capture prevents a late send and retains the unsent draft', async () => {
  await mount();
  let finishWindow!: (value: chrome.windows.Window) => void;
  vi.mocked(chrome.windows.getCurrent).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWindow = resolve;
      }),
  );
  await fill('#message', 'Still gathering the current tab');
  send.mockClear();
  await enter();
  expect(container.querySelector('#send')!.getAttribute('aria-label')).toBe('停止任务');
  await click('#send');
  await act(async () => finishWindow({ id: 1 } as chrome.windows.Window));
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'remote-stop' });
  expect(input().value).toBe('Still gathering the current tab');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test('a cancelled in-flight send cannot restore busy state or display a late send error', async () => {
  await mount();
  let finishSend!: (value: unknown) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSend = resolve;
      }),
  );
  await fill('#message', 'Pending send');
  await enter();
  await click('#send');
  await act(async () => finishSend({ ok: false, error: 'ui.error.sendFailed' }));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('#send')!.getAttribute('aria-label')).toBe('发送消息');
});

test('runtime updates render real tasks, stop/reveal remain wired, and disconnect disables sending', async () => {
  await mount();
  state = {
    ...state,
    task: {
      sessionId: 'task-1',
      phase: 'running',
      tabId: 5,
      tabCount: 2,
      title: '对比两款产品',
      url: 'https://example.com',
    },
  };
  await act(async () => {
    listener({ type: 'remote-updated', state });
  });
  expect(container.querySelector('.live-preview-title')?.textContent).toBe('对比两款产品');
  expect(container.querySelector('.live-preview-status')?.textContent).toContain('连接画面中');
  for (const phase of ['ready', 'paused', 'finished'] as const) {
    state.task!.phase = phase;
    await act(async () => listener({ type: 'remote-updated', state }));
    expect(container.querySelector('.live-preview')?.getAttribute('data-phase')).toBe(phase);
  }
  await click('.preview-view');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-preview-reveal' });
  await click('#stop-task');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-stop' });
  state = {
    ...state,
    task: null,
    chat: [{ role: 'assistant', text: '播放已开始', ts: Date.now() }],
  };
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelector('.live-preview')).toBeNull();
  expect(container.querySelector('.reply-status')).toBeNull();
  expect(container.querySelector('.message-text')?.textContent).toBe('播放已开始');
  state = { ...state, connected: false };
  await act(async () => {
    listener({ type: 'remote-updated', state });
  });
  expect(input().disabled).toBe(true);
  expect(container.querySelector('#stop-task')).toBeNull();
});

test('waiting uses one quiet waiting timer without delay warnings or resending', async () => {
  vi.useFakeTimers();
  state.chat = [{ role: 'user', text: '帮我看一下美股', ts: Date.now(), delivery: 'queued' }];
  await mount();
  expect(container.querySelector('.reply-status')?.textContent).toContain('接通中·0:00');
  expect(container.querySelector('.live-preview')).toBeNull();
  const sent = send.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_001);
  });
  expect(container.querySelector('.reply-status')?.textContent).toContain('接通中');
  expect(container.querySelectorAll('.tool-activity')).toHaveLength(1);
  expect(send.mock.calls.length).toBe(sent);
  state.chat.push({ role: 'assistant', text: '收到，正在查询', ts: Date.now(), final: false });
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelector('.reply-status')?.textContent).toContain('接通中·2:00');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_001);
  });
  expect(container.querySelector('.reply-status')?.textContent).toContain('接通中');
  expect(container.querySelectorAll('.tool-activity')).toHaveLength(1);
  state.chat.push({ role: 'assistant', text: '查询完成', ts: Date.now() });
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelector('.reply-status')).toBeNull();
});

test('delivery failure remains visible beside the user message after reopening the panel', async () => {
  state.chat = [
    {
      role: 'user',
      text: 'Check stocks',
      ts: Date.now(),
      delivery: 'failed',
      deliveryError: 'ui.error.chatDeliveryFailed',
    },
  ];
  await mount();
  expect(container.querySelector('.message-delivery')?.textContent).toContain(
    '未能送入 Agent 队列',
  );
  expect(container.querySelector('.reply-status')).toBeNull();
});

test('a new turn waits until a tool starts, then keeps working between tool responses', async () => {
  const now = Date.now();
  state.chat = [
    { role: 'user', text: '上一个任务', ts: now - 3000 },
    {
      role: 'system',
      text: '',
      ts: now - 2000,
      toolRun: {
        status: 'completed',
        startedAt: now - 2000,
        endedAt: now - 1000,
        total: 1,
        failed: 0,
        steps: [
          { id: 'old', number: 1, method: 'snapshot', status: 'success', queuedAt: now - 2000 },
        ],
      },
    },
    { role: 'assistant', text: '已完成', ts: now - 1000, final: true },
    { role: 'user', text: '新的任务', ts: now, delivery: 'queued' },
  ];
  await mount();
  expect(container.querySelector('.reply-status .tool-activity-title')?.textContent).toBe('接通中');
  const run: NonNullable<RemoteState['chat'][number]['toolRun']> = {
    status: 'running',
    startedAt: now,
    total: 1,
    failed: 0,
    steps: [{ id: 'new', number: 1, method: 'snapshot', status: 'queued', queuedAt: now }],
  };
  state.chat.push({ role: 'system', text: '', ts: now, toolRun: run });
  const title = () => [...container.querySelectorAll('.tool-activity-title')].at(-1)?.textContent;
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(title()).toBe('接通中');
  expect(container.querySelector('.tool-activity-context')).toBeNull();
  run.steps[0]!.status = 'running';
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(title()).toBe('正在读取页面');
  run.steps[0]!.status = 'success';
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(title()).toBe('正在分析页面内容');
});

test('reply delays keep the current task locked while still accepting its eventual answer', async () => {
  vi.useFakeTimers();
  const start = Date.now();
  state.loopActive = true;
  state.chat = [{ role: 'user', text: 'Read pages', ts: start, delivery: 'queued' }];
  await mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(110_000);
  });
  state.chat.push({
    role: 'system',
    text: '',
    ts: Date.now(),
    toolRun: {
      status: 'running',
      total: 1,
      failed: 0,
      startedAt: Date.now(),
      steps: [
        {
          id: 's1',
          number: 1,
          method: 'snapshot',
          status: 'running',
          queuedAt: Date.now(),
          startedAt: Date.now(),
        },
      ],
    },
  });
  await act(async () => listener({ type: 'remote-updated', state }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(121_000);
  });
  expect(container.querySelector('.reply-status')).toBeNull();
  expect(container.querySelectorAll('.tool-activity')).toHaveLength(1);
  expect(container.querySelector('.tool-activity-title')?.textContent).toBe('正在读取页面');
  expect(container.querySelector('.tool-activity-time')?.textContent).toBe('3:51');
  const step = state.chat[1]!.toolRun!.steps[0]!;
  step.status = 'success';
  step.endedAt = Date.now();
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelector('.tool-activity-title')?.textContent).toBe('正在分析页面内容');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_001);
  });
  expect(container.querySelector('.tool-activity-title')?.textContent).toBe('正在分析页面内容');
  expect(container.querySelector('.reply-status')).toBeNull();
  expect(input().disabled).toBe(false);
  await fill('#message', 'Continue');
  send.mockClear();
  await enter();
  expect(send).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(false);
  expect(container.querySelector('#send')!.getAttribute('aria-label')).toBe('停止任务');
  state.loopActive = false;
  state.chat.push({
    role: 'assistant',
    text: 'The late reply arrived',
    ts: Date.now(),
    final: true,
  });
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(container.querySelector('.reply-status')).toBeNull();
  expect(container.textContent).toContain('The late reply arrived');
  expect(input().value).toBe('Continue');
  expect(container.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(false);
});

test('header clear stays out of settings and cannot interrupt an active task', async () => {
  state.chat = [{ role: 'assistant', text: 'Keep until finished', ts: Date.now() }];
  state.loopActive = true;
  await mount();
  const clear = () =>
    container.querySelector<HTMLButtonElement>('.sidebar-header .clear-chat-button')!;
  expect(clear().disabled).toBe(true);
  send.mockClear();
  await click('.clear-chat-button');
  expect(send).not.toHaveBeenCalled();
  await click('.settings-button');
  expect(container.querySelector('#settings .clear-chat-button')).toBeNull();
  state.loopActive = false;
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(clear().disabled).toBe(false);
  state = { ...state, chat: [] };
  await click('.clear-chat-button');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-chat-clear' });
  expect(clear().disabled).toBe(true);
  expect(container.querySelector('#settings')).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>('#relay-url')?.value).toBe(
    'ws://localhost:3802/ext',
  );
  await click('#connection-enabled');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-set-enabled', enabled: false });
});

test('settings show the saved URL without exposing the key and return to chat after saving', async () => {
  await mount();
  await click('.settings-button');
  expect(container.querySelector<HTMLInputElement>('#relay-url')?.value).toBe(
    'ws://localhost:3802/ext',
  );
  expect(container.querySelector<HTMLInputElement>('#access-key')?.value).toBe('');
  expect(container.querySelector<HTMLInputElement>('#access-key')?.type).toBe('password');
  await fill('#access-key', 'ab'.repeat(32));
  await click('.save-button');
  expect(send).toHaveBeenLastCalledWith({
    type: 'remote-save',
    relayUrl: 'ws://localhost:3802/ext',
    key: 'ab'.repeat(32),
  });
  expect(container.querySelector('#settings')).toBeNull();
  await click('.settings-button');
  expect(container.querySelector<HTMLInputElement>('#access-key')?.value).toBe('');
});

test('saved English preference localizes the interface and errors without translating chat or restoring the header logo', async () => {
  savedPreferences.uiLanguage = 'en';
  state.chat = [{ role: 'assistant', text: '这条回复保持原文。', ts: Date.now() }];
  state.error = 'ui.error.connectionTaken';
  await mount();
  expect(document.documentElement.lang).toBe('en');
  expect(container.querySelector('.settings-button')?.textContent).toBe('Settings');
  expect(container.querySelector('.sidebar-header img')).toBeNull();
  expect(container.querySelector('.message-text')?.textContent).toBe('这条回复保持原文。');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'This browser instance connected elsewhere; this connection has been replaced',
  );
});

test('language selection updates immediately, persists after reopening, and can return to browser default', async () => {
  await mount();
  await click('.settings-button');
  const select = () => container.querySelector<HTMLSelectElement>('#interface-language')!;
  await act(async () => {
    select().value = 'en';
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(savedPreferences.uiLanguage).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(container.querySelector('#settings h1')?.textContent).toBe('Settings');
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await mount();
  expect(container.querySelector('.settings-button')?.textContent).toBe('Settings');
  await click('.settings-button');
  expect(select().value).toBe('en');
  await act(async () => {
    select().value = 'auto';
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(savedPreferences.uiLanguage).toBe('auto');
});

test('switching language updates saved task notices while preserving Agent replies and owner input', async () => {
  savedPreferences.uiLanguage = 'en';
  const notice = { kind: 'request-failed' as const, code: 'DECISION_TIMEOUT' };
  const original = formatTaskNotice('zh-CN', notice);
  state.chat = [
    { role: 'user', text: '保留我输入的中文', ts: 1 },
    { role: 'assistant', text: original, notice, ts: 2, final: true },
    { role: 'assistant', text: original, ts: 3, final: true },
  ];
  await mount();
  const replies = () =>
    [...container.querySelectorAll('.message.assistant .message-text')].map((el) => el.textContent);
  expect(replies()).toEqual([formatTaskNotice('en', notice), original]);
  await click('.settings-button');
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('#interface-language')!;
    select.value = 'zh-CN';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('.settings-button');
  expect(replies()).toEqual([original, original]);
  expect(container.querySelector('.message.user .message-text')?.textContent).toBe(
    '保留我输入的中文',
  );
  expect(state.chat[1]!.text).toBe(original);
});

test('preview shows only matching frames, retains completed image, and removes Stop after completion', async () => {
  queryTabs.mockResolvedValue([{ id: 99, windowId: 1 } as chrome.tabs.Tab]);
  await mount();
  const preview = {
    targetKey: 'task:3:1',
    sessionId: 'task',
    tabId: 3,
    windowId: 1,
    title: '原来的小红书页面',
    url: 'https://example.com/notes',
    status: 'running',
    availability: 'live',
    canReveal: true,
    canStop: true,
  };
  await act(async () => {
    previewListener({ type: 'preview-state', preview });
    previewListener({
      type: 'preview-frame',
      frame: {
        targetKey: 'task:3:1',
        sequence: 1,
        capturedAt: Date.now(),
        dataUrl: 'data:image/jpeg;base64,YWJj',
      },
    });
  });
  expect(container.querySelector('.live-preview-title')?.textContent).toBe('原来的小红书页面');
  expect(container.querySelector('.composer-field > .live-preview')).not.toBeNull();
  expect(container.querySelector('.live-preview-image')?.getAttribute('src')).toBe(
    'data:image/jpeg;base64,YWJj',
  );
  expect(container.querySelector('#stop-task')).not.toBeNull();
  await act(async () =>
    previewListener({
      type: 'preview-state',
      preview: { ...preview, status: 'completed', canStop: false, availability: 'paused' },
    }),
  );
  expect(container.querySelector('.live-preview-completed')).not.toBeNull();
  expect(container.querySelector('.live-preview-status')?.textContent).toBe('已完成');
  expect(container.querySelector('#stop-task')).toBeNull();
  expect(container.querySelector('.live-preview-image')?.getAttribute('src')).toBe(
    'data:image/jpeg;base64,YWJj',
  );
  await click('.preview-view');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-preview-reveal' });
  await act(async () =>
    previewListener({
      type: 'preview-state',
      preview: { ...preview, targetKey: 'task:4:2', tabId: 4, title: '另一个任务标签页' },
    }),
  );
  expect(container.querySelector('.live-preview-image')).toBeNull();
  await act(async () =>
    previewListener({
      type: 'preview-frame',
      frame: {
        targetKey: 'task:3:1',
        sequence: 2,
        capturedAt: Date.now(),
        dataUrl: 'data:image/jpeg;base64,YWJj',
      },
    }),
  );
  expect(container.querySelector('.live-preview-image')).toBeNull();
});

test('preview failure retains controls; stopped and interrupted tasks do not show success', async () => {
  queryTabs.mockResolvedValue([{ id: 99, windowId: 1 } as chrome.tabs.Tab]);
  await mount();
  const preview = {
    targetKey: 'task:3:1',
    sessionId: 'task',
    tabId: 3,
    windowId: 1,
    title: 'Task',
    url: 'https://example.com',
    status: 'running',
    availability: 'unavailable',
    canReveal: true,
    canStop: true,
  };
  await act(async () => previewListener({ type: 'preview-state', preview }));
  expect(container.querySelector('.live-preview-placeholder')?.textContent).toContain(
    '暂时无法预览',
  );
  expect(container.querySelector('#stop-task')).not.toBeNull();
  for (const status of ['stopped', 'interrupted', 'error']) {
    await act(async () =>
      previewListener({
        type: 'preview-state',
        preview: { ...preview, status, canStop: false, canReveal: false },
      }),
    );
    expect(container.querySelector('.live-preview-completed')).toBeNull();
    expect(container.querySelector('#stop-task')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.preview-view')?.disabled).toBe(true);
  }
  await act(async () => previewListener({ type: 'preview-state', preview: null }));
  expect(container.querySelector('.live-preview')).toBeNull();
});

test('closing preview suspends frames without stopping the task and keeps lifecycle controls accurate', async () => {
  queryTabs.mockResolvedValue([{ id: 99, windowId: 1 } as chrome.tabs.Tab]);
  await mount();
  const preview = {
    targetKey: 'task:3:1',
    sessionId: 'task',
    tabId: 3,
    windowId: 1,
    title: 'Current page',
    url: 'https://example.com',
    status: 'running',
    availability: 'live',
    canReveal: true,
    canStop: true,
  };
  await act(async () => previewListener({ type: 'preview-state', preview }));
  send.mockClear();
  await click('.preview-close');
  expect(container.querySelector('.live-preview')).toBeNull();
  expect(container.querySelector('.preview-restore')?.textContent).toBe('显示预览');
  expect(container.querySelector('#stop-task')).not.toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(previewPost).toHaveBeenLastCalledWith({ type: 'visibility', visible: false });
  await act(async () =>
    previewListener({
      type: 'preview-state',
      preview: { ...preview, tabId: 4, targetKey: 'task:4:2' },
    }),
  );
  expect(container.querySelector('.live-preview')).toBeNull();
  await click('.preview-restore');
  expect(container.querySelector('.live-preview')?.getAttribute('data-tab-id')).toBe('4');
  expect(previewPost).toHaveBeenLastCalledWith({ type: 'visibility', visible: true });
  await click('.preview-close');
  await click('#stop-task');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-stop' });
  await act(async () =>
    previewListener({
      type: 'preview-state',
      preview: { ...preview, status: 'completed', canStop: false, availability: 'paused' },
    }),
  );
  expect(container.querySelector('.live-preview')).toBeNull();
  expect(container.querySelector('#stop-task')).toBeNull();
  await act(async () =>
    previewListener({
      type: 'preview-state',
      preview: { ...preview, sessionId: 'next-task', targetKey: 'next-task:3:1' },
    }),
  );
  expect(container.querySelector('.live-preview')).not.toBeNull();
  expect(previewPost).toHaveBeenLastCalledWith({ type: 'visibility', visible: true });
});

test('preview follows this window active tab without losing manual dismissal or task controls', async () => {
  state.loopActive = true;
  await mount();
  const preview = {
    targetKey: 'task:3:1',
    sessionId: 'task',
    tabId: 3,
    windowId: 1,
    title: 'Task page',
    url: 'https://example.com',
    status: 'running',
    availability: 'live',
    canReveal: true,
    canStop: true,
  };
  const activate = async (tabId: number, windowId = 1) => {
    await act(async () => {
      if (windowId === 1) queryTabs.mockResolvedValue([{ id: tabId, windowId } as chrome.tabs.Tab]);
      for (const [handler] of vi.mocked(chrome.tabs.onActivated.addListener).mock.calls)
        handler({ tabId, windowId });
    });
  };
  await act(async () => previewListener({ type: 'preview-state', preview }));
  expect(container.querySelector('.live-preview')).toBeNull();
  expect(container.querySelector('.preview-restore')).toBeNull();
  expect(previewPost).toHaveBeenLastCalledWith({ type: 'visibility', visible: false });
  expect(container.querySelector('#send')?.getAttribute('aria-label')).toBe('停止任务');
  await activate(4);
  expect(container.querySelector('.live-preview')?.getAttribute('data-tab-id')).toBe('3');
  expect(previewPost).toHaveBeenLastCalledWith({ type: 'visibility', visible: true });
  await activate(3, 2); // An activation in another Chrome window does not affect this panel.
  expect(container.querySelector('.live-preview')).not.toBeNull();
  await activate(3);
  expect(container.querySelector('.live-preview')).toBeNull();
  expect(previewPost).toHaveBeenLastCalledWith({ type: 'visibility', visible: false });
  await activate(4);
  await click('.preview-close');
  await activate(3);
  expect(container.querySelector('.preview-restore')).toBeNull();
  await activate(4);
  expect(container.querySelector('.live-preview')).toBeNull();
  expect(container.querySelector('.preview-restore')).not.toBeNull();
  await act(async () =>
    previewListener({
      type: 'preview-state',
      preview: {
        ...preview,
        tabId: 4,
        sessionId: 'next-task',
        targetKey: 'next-task:4:1',
      },
    }),
  );
  expect(container.querySelector('.live-preview')).toBeNull();
  await activate(5);
  expect(container.querySelector('.live-preview')?.getAttribute('data-tab-id')).toBe('4');
  expect(previewPost).toHaveBeenLastCalledWith({ type: 'visibility', visible: true });
});

test('live Agent activity replaces the same line, expires, and yields to local browser actions', async () => {
  vi.useFakeTimers();
  state.loopActive = true;
  state.chat = [{ id: 'task', role: 'user', text: 'Research', ts: Date.now(), delivery: 'queued' }];
  await mount();
  const title = () => container.querySelector('.tool-activity-title')?.textContent;
  const update = () => act(async () => listener({ type: 'remote-updated', state }));
  state.agentActivity = {
    endpointId: 'endpoint',
    taskId: 'task',
    sequence: 1,
    category: 'command',
    detail: 'python3',
    receivedAt: Date.now(),
  };
  await update();
  expect(title()).toBe('执行命令 · python3');
  state.agentActivity = {
    ...state.agentActivity,
    sequence: 2,
    category: 'read',
    detail: undefined,
  };
  await update();
  expect(title()).toBe('读取文件');
  expect(container.querySelectorAll('.tool-activity')).toHaveLength(1);
  expect(container.querySelector('.tool-activity-context')).toBeNull();
  expect(container.textContent).not.toContain('python3');
  state.chat.push({
    role: 'system',
    text: '',
    ts: Date.now(),
    toolRun: {
      status: 'running',
      startedAt: Date.now(),
      total: 1,
      failed: 0,
      steps: [
        { id: 'scroll', number: 1, method: 'scroll', status: 'running', queuedAt: Date.now() },
      ],
    },
  });
  await update();
  expect(title()).toBe('正在滚动查看更多内容');
  state.chat[1]!.toolRun!.steps[0]!.status = 'success';
  await update();
  expect(title()).toBe('读取文件');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(31_000);
  });
  expect(title()).toBe('正在分析滚动后的页面');
  state.agentActivity = { ...state.agentActivity, taskId: 'different', receivedAt: Date.now() };
  await update();
  expect(title()).toBe('正在分析滚动后的页面');
  state.chat[1]!.toolRun!.status = 'completed';
  state.chat[1]!.toolRun!.endedAt = Date.now();
  state.chat.push({ role: 'assistant', text: 'Done', ts: Date.now(), final: true });
  await update();
  expect(title()).toBeUndefined();
  expect(container.querySelector('.tool-activity-time')?.textContent).toBe('用时 0:31');
});

test('a quiet Agent after a real activity never returns to Connecting, including a cleared or stale status', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  state.loopActive = true;
  state.chat = [{ id: 'task', role: 'user', text: 'Hello', ts: now, delivery: 'queued' }];
  await mount();
  const title = () => container.querySelector('.tool-activity-title')?.textContent;
  expect(title()).toBe('接通中');
  state.agentActivity = {
    endpointId: 'endpoint',
    taskId: 'task',
    sequence: 1,
    category: 'read',
    receivedAt: now,
  };
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(title()).toBe('读取文件');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(31_000);
  });
  expect(title()).toBe('等待 Agent 回复');
  state.agentActivity = {
    ...state.agentActivity,
    category: 'idle',
    sequence: 2,
    receivedAt: Date.now(),
  };
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(title()).toBe('等待 Agent 回复');
  state.chat.push({
    id: 'other-task',
    role: 'user',
    text: 'Another question',
    ts: Date.now(),
    delivery: 'queued',
  });
  await act(async () => listener({ type: 'remote-updated', state }));
  expect(title()).toBe('接通中');
});
