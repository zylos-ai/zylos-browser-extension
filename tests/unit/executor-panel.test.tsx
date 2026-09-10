import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExecutorPanel } from '../../components/ExecutorPanel';
import { initialPlatformState, platformTaskSchema, type PlatformState } from '../../utils/platform';

let state: PlatformState;
beforeEach(() => {
  state = { ...initialPlatformState };
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async () => ({ ok: true, value: state })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: { create: vi.fn() },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('被撤销的缓存设备不显示为已连接，并提供重新登录和移除入口', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  state = {
    ...state,
    authRequired: true,
    connected: true, // 即使旧状态残留，也优先显示认证状态。
    user: { identity_id: id, display_name: 'Test · Chrome' },
  };
  render(<ExecutorPanel />);
  await screen.findByText('需要重新连接');
  expect(screen.queryByText('浏览器已连接')).toBeNull();
  expect(screen.queryByRole('button', { name: '打开 OpenMAX 对话' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
  await waitFor(() =>
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'platform-login' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '移除失效连接' }));
  await waitFor(() =>
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'platform-disconnect' }),
  );
});

it('首次连接保留原登录入口', async () => {
  render(<ExecutorPanel />);
  expect(await screen.findByRole('button', { name: '登录并连接' })).toBeTruthy();
});

function runningTask() {
  const id = '11111111-1111-4111-8111-111111111111';
  return platformTaskSchema.parse({
    id,
    endpoint_id: id,
    connection_epoch: id,
    owner_identity_id: id,
    activation_id: id,
    control_session_id: id,
    state: 'running',
    revision: '3',
    deadline: new Date().toISOString(),
    absolute_deadline: new Date().toISOString(),
    outcome: '',
    cleanup_state: 'not_required',
  });
}
it('已授权但未创建工作页时，不显示正在操作或查看入口，仍可停止', async () => {
  state = { ...state, connected: true, task: runningTask(), hasWorkTab: false };
  render(<ExecutorPanel />);
  await screen.findByText('已授权，等待 Agent 打开网页');
  expect(screen.queryByText('Agent 正在操作')).toBeNull();
  expect(screen.queryByRole('button', { name: '查看工作标签' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  await waitFor(() =>
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'platform-decide',
      action: 'stop',
      taskId: state.task!.id,
    }),
  );
});
it('真实工作页出现才显示查看按钮，消失后即时移除', async () => {
  state = { ...state, connected: true, task: runningTask(), hasWorkTab: true };
  render(<ExecutorPanel />);
  fireEvent.click(await screen.findByRole('button', { name: '查看工作标签' }));
  await waitFor(() =>
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'platform-reveal' }),
  );
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0];
  listener({ type: 'platform-updated', state: { ...state, hasWorkTab: false } }, {}, () => {});
  await waitFor(() => expect(screen.queryByRole('button', { name: '查看工作标签' })).toBeNull());
});
it('暂停但没有工作页时，不展示失效的打开工作标签入口', async () => {
  state = { ...state, task: { ...runningTask(), state: 'waiting_user' }, hasWorkTab: false };
  render(<ExecutorPanel />);
  await screen.findByText('等待你操作');
  expect(screen.queryByRole('button', { name: '打开工作标签' })).toBeNull();
});
