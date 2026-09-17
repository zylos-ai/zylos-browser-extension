// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executor = vi.hoisted(() => ({
  createTask: vi.fn(),
  release: vi.fn(async () => {}),
  completeTask: vi.fn(async () => {}),
  currentControl: vi.fn(
    (): null | {
      sessionId: string;
      tabId: number;
      tabIds: number[];
      phase: 'ready' | 'paused' | 'finished';
    } => null,
  ),
  currentGrant: vi.fn((): null | { url: string; title: string } => null),
  execute: vi.fn(async (c: { op: string }) => ({ ran: c.op })),
  onState: vi.fn(),
  initializeExecutor: vi.fn(),
  revealTask: vi.fn(async () => {}),
}));
vi.mock('../../utils/automation/executor', () => executor);
vi.mock('../../utils/automation/task-lifecycle', () => ({ recoverTasks: vi.fn(async () => {}) }));
vi.mock('../../utils/messages', () => ({ isPanelSender: () => true }));

import { startRemoteBackground } from '../../entrypoints/background/remote';
import { REMOTE_SUBPROTOCOL, type ChatEntry } from '../../utils/remote';

type Handler = (m: unknown, s: unknown, r: (v: unknown) => void) => boolean;
let internal: Handler;
let sockets: Socket[];
let storage: Record<string, unknown>;
let broadcasts: unknown[];
const KEY = 'a'.repeat(64);

class Socket {
  static OPEN = 1;
  readyState = 0;
  frames: Record<string, unknown>[] = [];
  onopen?: () => void;
  onclose?: (ev: { code: number }) => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    sockets.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(raw: string) {
    this.frames.push(JSON.parse(raw));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  last(type: string) {
    return [...this.frames].reverse().find((f) => f.type === type);
  }
}

const ask = (m: unknown) =>
  new Promise<{ ok: boolean; value?: Record<string, unknown>; error?: string }>((resolve) =>
    internal(m, {}, (v) => resolve(v as never)),
  );
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sockets = [];
  broadcasts = [];
  storage = {
    remoteConfig: { relayUrl: 'wss://agent.example/browser-remote/ext', key: KEY, enabled: true },
  };
  executor.currentControl.mockReturnValue(null);
  executor.currentGrant.mockReturnValue(null);
  executor.completeTask.mockImplementation(async () => {
    executor.currentControl.mockReturnValue(null);
    executor.currentGrant.mockReturnValue(null);
  });
  executor.execute.mockImplementation(async (c: { op: string }) => ({ ran: c.op }));
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('crypto', {
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    subtle: { digest: async () => new Uint8Array(32).fill(0xab).buffer },
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'x'.repeat(32),
      onConnect: { addListener: vi.fn() },
      sendMessage: vi.fn(async (m: unknown) => {
        broadcasts.push(m);
      }),
      onMessage: {
        addListener: (h: Handler) => {
          internal = h;
        },
      },
    },
    storage: {
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      local: {
        setAccessLevel: vi.fn(async () => {}),
        get: vi.fn(async (keys: string[]) =>
          Object.fromEntries(keys.filter((k) => k in storage).map((k) => [k, storage[k]])),
        ),
        set: vi.fn(async (obj: Record<string, unknown>) => Object.assign(storage, obj)),
      },
    },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1, incognito: false })) },
    debugger: { onEvent: { addListener: vi.fn() }, sendCommand: vi.fn(async () => {}) },
    tabs: {
      query: vi.fn(async () => [{ id: 3, windowId: 1 }]),
      onRemoved: { addListener: vi.fn() },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function bootConnected() {
  startRemoteBackground();
  await flush();
  const ws = sockets[0]!;
  ws.open();
  await flush();
  return ws;
}

describe('remote background', () => {
  it('records real queue/start/result states and persists a closed trace with the final reply', async () => {
    const ws = await bootConnected();
    await ask({ type: 'remote-chat-send', text: 'Read this page' });
    let resolve!: (value: { ran: string }) => void;
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    ws.receive({ type: 'req', id: 1, method: 'snapshot', params: {} });
    await flush();
    ws.receive({ type: 'req', id: 2, method: 'click', params: { x: 20, y: 30 } });
    await flush();
    const history = async () => (await ask({ type: 'remote-state' })).value!.chat as ChatEntry[];
    const run = async () => (await history()).find((m) => m.toolRun)!.toolRun!;
    expect((await run()).steps.map((s) => [s.method, s.status])).toEqual([
      ['snapshot', 'running'],
      ['click', 'queued'],
    ]);
    await vi.advanceTimersByTimeAsync(500);
    executor.execute.mockRejectedValueOnce(
      Object.assign(new Error('page output must not be stored'), { code: 'STALE_REF' }),
    );
    resolve({ ran: 'snapshot' });
    await flush();
    expect((await run()).steps.map((s) => s.status)).toEqual(['success', 'error']);
    expect((await run()).steps[0]!.endedAt! - (await run()).steps[0]!.startedAt!).toBe(500);
    ws.receive({ type: 'chat', text: 'Recovering', final: false });
    await flush();
    expect((await run()).status).toBe('running');
    ws.receive({ type: 'chat', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'Done' });
    await flush();
    expect(await run()).toMatchObject({ status: 'completed', total: 2, failed: 1 });
    expect(
      (storage.remoteChatLog as ChatEntry[]).map((m) => (m.toolRun ? 'steps' : m.text)),
    ).toEqual(['Read this page', 'steps', 'Recovering', 'Done']);
    expect(JSON.stringify(storage.remoteChatLog)).not.toContain('page output must not be stored');
    ws.receive({ type: 'req', id: 3, method: 'snapshot', params: {} });
    await flush();
    ws.receive({ type: 'chat', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'Done' });
    await flush();
    expect((await history()).filter((m) => m.toolRun).at(-1)!.toolRun!.status).toBe('running');
  });

  it('clearing history cannot be undone by a late result or a scheduled history write', async () => {
    const ws = await bootConnected();
    let resolve!: (value: { ran: string }) => void;
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    ws.receive({ type: 'req', id: 1, method: 'screenshot', params: {} });
    await flush();
    await ask({ type: 'remote-chat-clear' });
    resolve({ ran: 'screenshot' });
    await vi.advanceTimersByTimeAsync(500);
    expect(storage.remoteChatLog).toEqual([]);
    expect((await ask({ type: 'remote-state' })).value!.chat).toEqual([]);
  });

  it('records interrupted work on disconnect and never restores a running trace after worker restart', async () => {
    const ws = await bootConnected();
    let resolve!: (value: { ran: string }) => void;
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    ws.receive({ type: 'req', id: 1, method: 'snapshot', params: {} });
    await flush();
    await vi.advanceTimersByTimeAsync(300);
    const beforeDisconnect = structuredClone(storage.remoteChatLog);
    ws.serverClose(4001);
    await vi.advanceTimersByTimeAsync(300);
    expect((storage.remoteChatLog as ChatEntry[])[0]!.toolRun).toMatchObject({
      status: 'interrupted',
      steps: [{ status: 'interrupted' }],
    });
    resolve({ ran: 'snapshot' });
    await flush();
    storage.remoteChatLog = beforeDisconnect;
    startRemoteBackground();
    await flush();
    expect((storage.remoteChatLog as ChatEntry[])[0]!.toolRun).toMatchObject({
      status: 'interrupted',
      steps: [{ status: 'interrupted' }],
    });
  });

  it('keeps stop effective when storing tool history fails', async () => {
    const ws = await bootConnected();
    ws.receive({ type: 'req', id: 1, method: 'snapshot', params: {} });
    await flush();
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('Storage unavailable'));
    expect((await ask({ type: 'remote-stop' })).ok).toBe(false);
    expect(executor.release).toHaveBeenCalledOnce();
    const log = (await ask({ type: 'remote-state' })).value!.chat as ChatEntry[];
    expect(log[0]!.toolRun!.status).toBe('stopped');
  });

  it('acknowledges a persisted final reply once and does not end a new task on replay', async () => {
    const ws = await bootConnected();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let save!: () => void;
    vi.mocked(chrome.storage.local.set).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          save = resolve;
        }),
    );
    ws.receive({ type: 'chat', id, text: 'Done' });
    ws.receive({ type: 'chat', id, text: 'Done' });
    await flush();
    expect(ws.last('chat-ack')).toBeUndefined();
    save();
    await flush();
    expect(ws.last('chat-ack')).toMatchObject({ id });
    expect(executor.completeTask).toHaveBeenCalledOnce();
    expect(storage.remoteChatReceipts).toContain(id);
    const next = { sessionId: 'next', tabId: 4, tabIds: [4], phase: 'ready' as const };
    executor.currentControl.mockReturnValue(next);
    await ask({ type: 'remote-chat-clear' });
    ws.receive({ type: 'chat', id, text: 'Done' });
    await flush();
    expect(executor.completeTask).toHaveBeenCalledOnce();
    expect(executor.currentControl()).toEqual(next);
    expect(storage.remoteChatLog).toEqual([]);
  });

  it('keeps acknowledgement history after clearing chat and restarting the worker', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    storage.remoteChatReceipts = [id];
    const ws = await bootConnected();
    ws.receive({ type: 'chat', id, text: 'Already received' });
    await flush();
    expect(ws.last('chat-ack')).toMatchObject({ id });
    expect(executor.completeTask).not.toHaveBeenCalled();
    expect((await ask({ type: 'remote-state' })).value?.chat).toEqual([]);
  });

  it('does not acknowledge failed persistence and retries without duplicating the bubble', async () => {
    const ws = await bootConnected();
    const message = { type: 'chat', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'Result' };
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('storage unavailable'));
    ws.receive(message);
    await flush();
    expect(ws.last('chat-ack')).toBeUndefined();
    expect((await ask({ type: 'remote-state' })).value?.error).toBe('ui.error.chatSaveFailed');
    ws.receive(message);
    await flush();
    expect(ws.last('chat-ack')).toMatchObject({ id: message.id });
    expect(storage.remoteChatLog).toHaveLength(1);
  });

  it('answers heartbeats while a screenshot promise is still pending', async () => {
    const ws = await bootConnected();
    let resolve!: (value: { ran: string }) => void;
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    ws.receive({ type: 'req', id: 1, method: 'screenshot', params: {} });
    await flush();
    ws.receive({ type: 'ping', ts: 123 });
    await flush();
    expect(ws.last('pong')).toEqual({ type: 'pong', ts: 123 });
    expect(ws.last('resp')).toBeUndefined();
    resolve({ ran: 'screenshot' });
    await flush();
  });

  it('shows command activity and removes the task when the final answer arrives', async () => {
    const ws = await bootConnected();
    const task = { sessionId: 'task', tabId: 3, tabIds: [3], phase: 'ready' as const };
    executor.currentControl.mockReturnValue(task);
    executor.currentGrant.mockReturnValue({ url: 'https://example.com', title: 'Video' });
    expect((await ask({ type: 'remote-state' })).value?.task).toMatchObject({ phase: 'ready' });
    let resolve!: (value: { ran: string }) => void;
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    ws.receive({ type: 'req', id: 1, method: 'click', params: { x: 10, y: 10 } });
    await flush();
    expect((await ask({ type: 'remote-state' })).value?.task).toMatchObject({ phase: 'running' });
    resolve({ ran: 'click' });
    await flush();
    expect((await ask({ type: 'remote-state' })).value?.task).toMatchObject({ phase: 'ready' });
    executor.execute.mockImplementationOnce(async () => {
      executor.currentControl.mockReturnValue({ ...task, phase: 'finished' });
      executor.currentGrant.mockReturnValue(null);
      return { ran: 'finish' };
    });
    ws.receive({ type: 'req', id: 2, method: 'finish', params: {} });
    await flush();
    expect((await ask({ type: 'remote-state' })).value?.task).toMatchObject({
      phase: 'finished',
      title: 'Video',
    });
    ws.receive({ type: 'chat', text: 'Done' });
    await flush();
    expect(executor.completeTask).toHaveBeenCalledOnce();
    expect((await ask({ type: 'remote-state' })).value?.task).toBeNull();
  });

  it('keeps explicit progress and system messages active; a final reply cancels queued commands', async () => {
    const ws = await bootConnected();
    executor.currentControl.mockReturnValue({
      sessionId: 'task',
      tabId: 3,
      tabIds: [3],
      phase: 'ready',
    });
    ws.receive({ type: 'chat', text: 'Searching', final: false });
    ws.receive({ type: 'chat', role: 'system', text: 'Notice' });
    await flush();
    expect(executor.completeTask).not.toHaveBeenCalled();
    expect((storage.remoteChatLog as unknown[])[0]).toMatchObject({ final: false });
    let resolve!: (value: { ran: string }) => void;
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    ws.receive({ type: 'req', id: 1, method: 'click', params: { x: 10, y: 10 } });
    await flush();
    ws.receive({ type: 'req', id: 2, method: 'click', params: { x: 20, y: 20 } });
    ws.receive({ type: 'chat', text: 'Done', final: true });
    await flush();
    expect((await ask({ type: 'remote-state' })).value?.task).toBeNull();
    resolve({ ran: 'click' });
    await flush();
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(ws.last('error')).toMatchObject({ id: 2, code: 'STOPPED' });
    expect((await ask({ type: 'remote-state' })).value?.task).toBeNull();
  });

  it('a final reply prevents a pending source lookup from creating a new task', async () => {
    const ws = await bootConnected();
    let resolve!: (tabs: unknown[]) => void;
    vi.mocked(chrome.tabs.query).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r as never;
        }),
    );
    ws.receive({ type: 'req', id: 1, method: 'open', params: { url: 'https://example.com' } });
    await flush();
    ws.receive({ type: 'chat', text: 'Done' });
    await flush();
    resolve([{ id: 3, windowId: 1 }]);
    await flush();
    expect(ws.last('error')).toMatchObject({ id: 1, code: 'STOPPED' });
    expect(executor.createTask).not.toHaveBeenCalled();
  });

  it('still displays the final answer if browser cleanup fails', async () => {
    const ws = await bootConnected();
    executor.completeTask.mockRejectedValueOnce(new Error('detach failed'));
    ws.receive({ type: 'chat', text: 'Result' });
    await flush();
    const state = (await ask({ type: 'remote-state' })).value!;
    expect(state.error).toBe('ui.error.taskCleanupFailed');
    expect(state.chat).toEqual([expect.objectContaining({ text: 'Result', final: true })]);
  });

  it('records queue receipts and failures on the matching message, including persisted delivery errors', async () => {
    const ws = await bootConnected();
    await ask({ type: 'remote-chat-send', text: 'Check stocks' });
    const chatId = ws.last('chat')!.id;
    ws.receive({ type: 'chat-status', chatId: 'unrelated', state: 'failed' });
    await flush();
    expect((storage.remoteChatLog as { delivery: string }[])[0]!.delivery).toBe('sent');
    ws.receive({ type: 'chat-status', chatId, state: 'queued' });
    await flush();
    expect((storage.remoteChatLog as { delivery: string }[])[0]!.delivery).toBe('queued');
    ws.receive({ type: 'chat-status', chatId, state: 'failed', code: 'C4_DELIVERY_FAILED' });
    await flush();
    expect((storage.remoteChatLog as unknown[])[0]).toMatchObject({
      text: 'Check stocks',
      delivery: 'failed',
      deliveryError: 'ui.error.chatDeliveryFailed',
    });
    expect((await ask({ type: 'remote-state' })).value?.connected).toBe(true);
    ws.receive({ type: 'chat-status', chatId, state: 'unknown', code: 'C4_DELIVERY_TIMEOUT' });
    await flush();
    expect((storage.remoteChatLog as unknown[])[0]).toMatchObject({
      delivery: 'unknown',
      deliveryError: 'ui.error.deliveryUnconfirmed',
    });
    ws.receive({ type: 'chat-status', chatId, state: 'failed', code: 'AGENT_UNAVAILABLE' });
    await flush();
    expect((storage.remoteChatLog as unknown[])[0]).toMatchObject({
      deliveryError: 'ui.error.agentUnavailable',
    });
  });

  it('a late result from an old socket cannot clear a new command with the same id', async () => {
    const ws = await bootConnected();
    executor.currentControl.mockReturnValue({
      sessionId: 'task',
      tabId: 3,
      tabIds: [3],
      phase: 'ready',
    });
    let oldResolve!: (value: { ran: string }) => void;
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResolve = resolve;
        }),
    );
    ws.receive({ type: 'req', id: 1, method: 'click', params: { x: 10, y: 10 } });
    await flush();
    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    const next = sockets[1]!;
    next.open();
    let newResolve!: (value: { ran: string }) => void;
    // dialog bypasses the previous request's serial queue, as it must for waits.
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          newResolve = resolve;
        }),
    );
    next.receive({ type: 'req', id: 1, method: 'dialog', params: { action: 'get' } });
    await flush();
    oldResolve({ ran: 'click' });
    await flush();
    expect((await ask({ type: 'remote-state' })).value?.task).toMatchObject({ phase: 'running' });
    expect(next.last('resp')).toBeUndefined();
    newResolve({ ran: 'dialog' });
    await flush();
    expect((await ask({ type: 'remote-state' })).value?.task).toMatchObject({ phase: 'ready' });
  });

  it('dials the relay with the key in the subprotocol and says hello', async () => {
    const ws = await bootConnected();
    expect(ws.url).toBe('wss://agent.example/browser-remote/ext');
    expect(ws.protocols).toEqual([REMOTE_SUBPROTOCOL, `key.${KEY}`]);
    const hello = ws.last('hello') as { version: string; capabilities: string[] };
    expect(hello.capabilities).toContain('open');
    const st = await ask({ type: 'remote-state' });
    expect(st.value).toMatchObject({ connected: true, configured: true, keyId: 'abababababab' });
  });

  it('does not dial when unconfigured or disabled', async () => {
    storage = {};
    startRemoteBackground();
    await flush();
    expect(sockets).toHaveLength(0);
    const st = await ask({ type: 'remote-state' });
    expect(st.value).toMatchObject({ configured: false, connected: false });
  });

  it('answers ping and dispatches req to the executor', async () => {
    const ws = await bootConnected();
    ws.receive({ type: 'ping', ts: 5 });
    expect(ws.last('pong')).toEqual({ type: 'pong', ts: 5 });

    ws.receive({
      type: 'req',
      id: 1,
      method: 'open',
      params: { url: 'https://example.com/' },
      requestId: 'r1',
    });
    await flush();
    expect(executor.createTask).toHaveBeenCalled();
    const resp = ws.frames.find((f) => f.id === 1) as {
      type: string;
      result: { started: boolean };
    };
    expect(resp.type).toBe('resp');
    expect(resp.result.started).toBe(true);

    ws.receive({ type: 'req', id: 2, method: 'Runtime.evaluate', params: {} });
    await flush();
    expect(ws.frames.find((f) => f.id === 2)).toMatchObject({
      type: 'error',
      code: 'UNKNOWN_METHOD',
    });

    ws.receive({ type: 'req', id: 3, method: 'open', params: { url: 'https://paypal.com/' } });
    await flush();
    expect(ws.frames.find((f) => f.id === 3)).toMatchObject({ type: 'error', code: 'BLOCKED_URL' });
  });

  it('carries chat both ways and persists the log', async () => {
    const ws = await bootConnected();
    ws.receive({ type: 'chat', role: 'assistant', text: '好的，我来搜', ts: 10 });
    await flush();
    expect((storage.remoteChatLog as unknown[]).length).toBe(1);

    const r = await ask({ type: 'remote-chat-send', text: '  帮我搜蜘蛛侠  ' });
    expect(r.ok).toBe(true);
    expect(ws.last('chat')).toMatchObject({ type: 'chat', text: '帮我搜蜘蛛侠' });
    const chat = (r.value as { chat: { role: string; text: string }[] }).chat;
    expect(chat.map((c) => c.role)).toEqual(['assistant', 'user']);
    expect(broadcasts.some((b) => (b as { type: string }).type === 'remote-updated')).toBe(true);
  });

  it('refuses to send chat while offline', async () => {
    const ws = await bootConnected();
    ws.serverClose(1006);
    await flush();
    const r = await ask({ type: 'remote-chat-send', text: 'hi' });
    expect(r.ok).toBe(false);
  });

  it('reconnects with backoff after a drop, but not after being superseded', async () => {
    const ws = await bootConnected();
    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    await flush();
    sockets[1]!.serverClose(4001);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(2);
    const st = await ask({ type: 'remote-state' });
    expect(st.value?.error).toBe('ui.error.connectionTaken');
  });

  it('kill switch closes the socket and releases the task', async () => {
    const ws = await bootConnected();
    const r = await ask({ type: 'remote-set-enabled', enabled: false });
    expect(r.ok).toBe(true);
    expect(ws.readyState).toBe(3);
    expect(executor.release).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
    expect((storage.remoteConfig as { enabled: boolean }).enabled).toBe(false);
  });

  it('saving new settings redials with the new key', async () => {
    await bootConnected();
    const r = await ask({
      type: 'remote-save',
      relayUrl: 'wss://other.example/ext',
      key: 'b'.repeat(64),
    });
    expect(r.ok).toBe(true);
    await flush();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.protocols[1]).toBe(`key.${'b'.repeat(64)}`);
    const bad = await ask({ type: 'remote-save', relayUrl: 'http://nope', key: 'zzz' });
    expect(bad.ok).toBe(false);
  });
});
