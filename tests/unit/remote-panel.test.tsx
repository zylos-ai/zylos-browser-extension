import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LanguageProvider } from '../../components/LanguageProvider';
import { RemotePanel } from '../../components/RemotePanel';
import { initialRemoteState, type RemoteState } from '../../utils/remote';

let root: Root;
let container: HTMLDivElement;
let state: RemoteState;
let send: ReturnType<typeof vi.fn>;
let listener: (message: unknown) => void;
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
  vi.stubGlobal('chrome', {
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
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

test('starter prompts fill the composer and require a separate send; IME and Shift+Enter do not send', async () => {
  await mount();
  send.mockClear();
  await click('.starter');
  expect(input().value).toBe('找资料，整理成要点');
  expect(document.activeElement).toBe(input());
  expect(send).not.toHaveBeenCalled();
  await enter({ shiftKey: true });
  await enter({ isComposing: true });
  await enter({ keyCode: 229 });
  expect(send).not.toHaveBeenCalled();
  await enter();
  expect(send).toHaveBeenCalledExactlyOnceWith({
    type: 'remote-chat-send',
    text: '找资料，整理成要点',
  });
  expect(input().value).toBe('');
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

test('runtime updates render real tasks, stop/reveal remain wired, and disconnect disables sending', async () => {
  await mount();
  state = {
    ...state,
    task: {
      sessionId: 'task-1',
      tabId: 5,
      tabCount: 2,
      title: '对比两款产品',
      url: 'https://example.com',
    },
  };
  await act(async () => {
    listener({ type: 'remote-updated', state });
  });
  expect(container.querySelector('.task-title')?.textContent).toBe('对比两款产品');
  expect(container.querySelector('.task-card')?.textContent).toContain('2 个工作标签页');
  await click('.task-buttons button');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-reveal' });
  await click('#stop-task');
  expect(send).toHaveBeenLastCalledWith({ type: 'remote-stop' });
  state = { ...state, connected: false, task: null };
  await act(async () => {
    listener({ type: 'remote-updated', state });
  });
  expect(input().disabled).toBe(true);
  expect(container.querySelector('#stop-task')).toBeNull();
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
    'Another connection has taken over this key',
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
  expect(container.querySelector('#settings h1')?.textContent).toBe('Connect your Agent');
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
