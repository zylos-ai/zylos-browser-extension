import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../components/App';
import { initialState, type PanelState } from '../../utils/messages';

let state: PanelState;
let listeners: Set<(message: unknown, sender: unknown) => void>;
let sendMessage: ReturnType<typeof vi.fn>;
const response = () => ({ ok: true, value: structuredClone(state) });
function publish(next: Partial<PanelState>) {
  state = { ...state, ...next };
  act(() => {
    for (const listener of listeners)
      listener({ type: 'ui-state', state }, { id: 'test-extension' });
  });
}
beforeEach(() => {
  state = {
    ...initialState,
    ready: true,
    hasSavedConnection: true,
    status: '已连接 Agent',
    deviceId: 'fixture',
  };
  listeners = new Set();
  sendMessage = vi.fn(async () => response());
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension',
      sendMessage,
      onMessage: {
        addListener: (fn: typeof listeners extends Set<infer T> ? T : never) => listeners.add(fn),
        removeListener: (fn: typeof listeners extends Set<infer T> ? T : never) =>
          listeners.delete(fn),
      },
    },
    windows: { getCurrent: async () => ({ id: 7 }) },
    sidePanel: { open: vi.fn(async () => {}) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test('StrictMode cleans subscriptions; chat-first UI has no manual grant or debug details', async () => {
  const { unmount } = render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await screen.findByText('已连接');
  expect(listeners.size).toBe(1);
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(document.querySelector('#grant')).toBeNull();
  expect(screen.queryByText('已连接 Agent')).toBeNull();
  expect(document.querySelector('#device')).toBeNull();
  expect(screen.queryByRole('button', { name: '停止控制' })).toBeNull();
  publish({
    control: {
      scope: 'task',
      windowId: 7,
      sessionId: 'session',
      groupId: 10,
      tabId: 9,
      tabIds: [9],
    },
  });
  fireEvent.click(screen.getByRole('button', { name: '查看工作标签' }));
  await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'reveal-task' }));
  fireEvent.click(screen.getByRole('button', { name: '停止控制' }));
  await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'stop' }));
  publish({ control: null });
  expect(screen.queryByRole('button', { name: '停止控制' })).toBeNull();
  expect(sendMessage.mock.calls.some(([message]) => message.type === 'grant')).toBe(false);
  unmount();
  expect(listeners.size).toBe(0);
});
test('a late initial read cannot overwrite a newer background event', async () => {
  let resolve!: (value: unknown) => void;
  sendMessage.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<App />);
  publish({ ready: true, status: '新的连接状态' });
  await act(async () => {
    resolve({ ok: true, value: initialState });
  });
  expect(screen.queryByText('新的连接状态')).toBeNull();
  expect(screen.getByText('已连接')).toBeTruthy();
});
test('pairing settings are hidden in chat and do not discard the draft', async () => {
  render(<App />);
  await screen.findByText('已连接');
  expect(screen.queryByLabelText('Agent 地址')).toBeNull();
  const input = screen.getByRole('textbox', { name: '给 Agent 的消息' });
  fireEvent.change(input, { target: { value: '保留聊天草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByLabelText('一次性配对码')).toBeTruthy();
  expect(document.querySelector('.advanced-connection')?.hasAttribute('open')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '返回对话' }));
  expect(screen.queryByLabelText('一次性配对码')).toBeNull();
  expect((input as HTMLTextAreaElement).value).toBe('保留聊天草稿');
});
test('first pairing stays available; reconnect never grants browser control', async () => {
  state = { ...initialState };
  render(<App />);
  await screen.findByText('首次配对');
  const input = screen.getByRole('textbox', { name: '给 Agent 的消息' });
  fireEvent.change(input, { target: { value: '断线草稿' } });
  publish({ hasSavedConnection: true, ready: false, control: null });
  expect(screen.queryByLabelText('一次性配对码')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
  await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'reconnect' }));
  publish({ ready: true });
  expect((input as HTMLTextAreaElement).value).toBe('断线草稿');
  expect(screen.queryByRole('button', { name: '允许并继续' })).toBeNull();
  expect(
    sendMessage.mock.calls.some(([m]) => ['grant', 'approve-authorization'].includes(m.type)),
  ).toBe(false);
});
test('failed send keeps draft and error, and incoming messages render only as text', async () => {
  render(<App />);
  await screen.findByText('已连接');
  sendMessage.mockImplementation(async (message) =>
    message.type === 'chat' ? { ok: false, error: '连接暂时断开，请重试' } : response(),
  );
  const input = screen.getByRole('textbox', { name: '给 Agent 的消息' });
  fireEvent.change(input, { target: { value: '保留草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息 ↗' }));
  await screen.findByText('连接暂时断开，请重试');
  publish({
    history: [
      {
        id: '1',
        role: 'assistant',
        text: '<img src=x onerror=alert(1)>',
        at: new Date().toISOString(),
      },
    ],
  });
  expect((input as HTMLTextAreaElement).value).toBe('保留草稿');
  expect(screen.getByText('连接暂时断开，请重试')).toBeTruthy();
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  expect(document.querySelector('#history img')).toBeNull();
});
test('send acknowledgement does not erase a newer draft', async () => {
  render(<App />);
  await screen.findByText('已连接');
  let resolve!: (value: unknown) => void;
  sendMessage.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const input = screen.getByRole('textbox', { name: '给 Agent 的消息' });
  fireEvent.change(input, { target: { value: '第一条' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息 ↗' }));
  fireEvent.change(input, { target: { value: '正在写下一条' } });
  await act(async () => {
    resolve(response());
  });
  expect((input as HTMLTextAreaElement).value).toBe('正在写下一条');
});
test('chat is usable before consent and the inline authorization card needs only one explicit click', async () => {
  render(<App />);
  await screen.findByText('已连接');
  expect((screen.getByRole('button', { name: '发送消息 ↗' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(document.querySelector('details.manual-control')).toBeNull();
  const authorization = {
    id: crypto.randomUUID(),
    requestContext: crypto.randomUUID(),
    tool: 'agent_browser_open',
    goal: '<img src=x>打开 B 站',
    expiresAt: Date.now() + 300000,
    status: 'pending' as const,
  };
  publish({ authorization });
  expect(screen.getByText('允许 Agent 使用浏览器？')).toBeTruthy();
  expect(document.querySelector('#history img')).toBeNull();
  const button = screen.getByRole('button', { name: '允许并继续' });
  fireEvent.click(button);
  await waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'approve-authorization',
      id: authorization.id,
      windowId: 7,
    }),
  );
  publish({ authorization: { ...authorization, status: 'approving' } });
  expect((screen.getByRole('button', { name: '正在授权…' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  publish({ authorization: { ...authorization, status: 'approved' } });
  expect(screen.queryByRole('button', { name: '允许并继续' })).toBeNull();
  expect(screen.getByText('已授权专用工作标签')).toBeTruthy();
});
test('cancel and authorization errors are visible inline without clearing the chat draft', async () => {
  render(<App />);
  await screen.findByText('已连接');
  const authorization = {
    id: crypto.randomUUID(),
    requestContext: crypto.randomUUID(),
    tool: 'agent_browser_snapshot',
    goal: '查看页面',
    expiresAt: Date.now() + 300000,
    status: 'pending' as const,
  };
  publish({ authorization });
  sendMessage.mockImplementation(async (message) =>
    message.type === 'approve-authorization' ? { ok: false, error: '授权已过期' } : response(),
  );
  const input = screen.getByRole('textbox', { name: '给 Agent 的消息' });
  fireEvent.change(input, { target: { value: '下一条消息' } });
  fireEvent.click(screen.getByRole('button', { name: '允许并继续' }));
  await screen.findByText('授权已过期');
  expect((input as HTMLTextAreaElement).value).toBe('下一条消息');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith({ type: 'deny-authorization', id: authorization.id }),
  );
});
