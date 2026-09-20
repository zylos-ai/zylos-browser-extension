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
vi.mock('../../utils/browser-round', () => ({
  runBrowserRound: async (actions: any[], call: any, active: () => void, id: string) => {
    const results = [];
    for (const action of actions) {
      active();
      results.push(await call(action.method, action.params, id));
    }
    active();
    return {
      results,
      observation: { page: 'fresh state' },
      failed: false,
      mode: actions[0]?.method === 'read-page' ? 'reading' : 'operating',
    };
  },
}));
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
  let id = 0;
  vi.stubGlobal('crypto', {
    randomUUID: () => `11111111-1111-4111-8111-${String(++id).padStart(12, '0')}`,
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
  ws.receive({
    type: 'ready',
    capabilities: ['agent-loop-v1', 'browser-instance-v1'],
    endpointId: `abababababab.${storage.remoteBrowserId}`,
  });
  await flush();
  return ws;
}

const selectPage = async (ws: Socket) => {
  const request = await begin(ws);
  await respond(ws, request, {
    kind: 'actions',
    actions: [{ method: 'open', params: { url: 'https://example.com' } }],
  });
  return ws.last('agent-request')!;
};
const state = async () => (await ask({ type: 'remote-state' })).value!;
const begin = async (ws: Socket, text = 'Read this page') => {
  expect((await ask({ type: 'remote-chat-send', text })).ok).toBe(true);
  return ws.last('agent-request')!;
};
const respond = async (ws: Socket, request: Record<string, unknown>, decision: unknown, id = 1) => {
  ws.receive({ type: 'req', id, method: 'agent-decision', params: { id: request.id, decision } });
  await flush();
};

describe('decision transport background', () => {
  it('persists a random instance identity and reuses it after reconnect, clearing chat, and worker restart', async () => {
    const ws = await bootConnected();
    const id = storage.remoteBrowserId;
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(ws.last('hello')!.browserId).toBe(id);
    expect((await state()).endpointId).toBe(`abababababab.${id}`);
    await ask({ type: 'remote-chat-clear' });
    await ask({ type: 'remote-set-enabled', enabled: false });
    await ask({ type: 'remote-set-enabled', enabled: true });
    await flush();
    sockets[1]!.open();
    expect(sockets[1]!.last('hello')!.browserId).toBe(id);
    await ask({ type: 'remote-set-enabled', enabled: false });
    storage.remoteConfig = { relayUrl: 'wss://agent.example/ext', key: KEY, enabled: true };
    startRemoteBackground();
    await flush();
    sockets[2]!.open();
    expect(sockets[2]!.last('hello')!.browserId).toBe(id);
    expect(storage.remoteBrowserId).toBe(id);
  });

  it('fresh installations sharing a key get different identities', async () => {
    const ws = await bootConnected();
    const firstId = storage.remoteBrowserId;
    await ask({ type: 'remote-set-enabled', enabled: false });
    storage = { remoteConfig: { relayUrl: 'wss://agent.example/ext', key: KEY, enabled: true } };
    startRemoteBackground();
    await flush();
    sockets[1]!.open();
    expect(sockets[1]!.last('hello')!.browserId).not.toBe(firstId);
    expect(ws.last('hello')!.browserId).toBe(firstId);
  });

  it.each([
    { capabilities: ['agent-loop-v1'] },
    { capabilities: ['agent-loop-v1', 'browser-instance-v1'], endpointId: 'wrong-browser' },
  ])('rejects missing identity support or a mismatched endpoint: %j', async (reply) => {
    startRemoteBackground();
    await flush();
    const ws = sockets[0]!;
    ws.open();
    ws.receive({ type: 'ready', ...reply });
    await flush();
    expect((await state()).connected).toBe(false);
    expect((await state()).error).toBe('ui.error.protocolMismatch');
    expect((await ask({ type: 'remote-chat-send', text: 'Hello' })).ok).toBe(false);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('does not dial with an ephemeral identity if saving the identity fails', async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('storage unavailable'));
    startRemoteBackground();
    await flush();
    expect(sockets).toHaveLength(0);
    expect(broadcasts.at(-1)).toMatchObject({
      state: { error: expect.stringContaining('ui.error.initializationFailed') },
    });
  });

  it('a stop during initial DOM capture prevents the pending message from starting a turn', async () => {
    const ws = await bootConnected();
    const tab = { id: 3, windowId: 1, url: 'https://example.com/article', incognito: false };
    vi.mocked(
      chrome.tabs.query as (q: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>,
    ).mockResolvedValue([tab as chrome.tabs.Tab]);
    chrome.tabs.get = vi.fn(async () => tab) as never;
    chrome.webNavigation = {
      getFrame: vi.fn(async () => ({ documentId: 'doc', url: tab.url })),
    } as never;
    let release!: (value: unknown) => void;
    chrome.scripting = {
      executeScript: vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    } as never;
    chrome.debugger.attach = vi.fn() as never;
    const sending = ask({ type: 'remote-chat-send', text: 'Hello from article' });
    await flush();
    expect(chrome.scripting.executeScript).toHaveBeenCalledOnce();
    await ask({ type: 'remote-stop' });
    release([
      { documentId: 'doc', frameId: 0, result: { url: tab.url, text: 'Article', links: [] } },
    ]);
    await flush();
    expect((await sending).ok).toBe(false);
    expect(ws.last('agent-request')).toBeUndefined();
    expect((await state()).loopActive).toBe(false);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });
  it('authenticates, negotiates and answers ordinary chat without browser actions', async () => {
    const ws = await bootConnected();
    expect(ws.protocols).toEqual([REMOTE_SUBPROTOCOL, `key.${KEY}`]);
    expect(ws.last('hello')!.capabilities).toEqual(['agent-loop-v1', 'browser-instance-v1']);
    const request = await begin(ws, 'Hello');
    expect(ws.last('chat')).toBeUndefined();
    await respond(ws, request, { kind: 'done', text: 'Hello back' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect((await state()).chat).toEqual([
      expect.objectContaining({ role: 'user', loopStatus: 'done' }),
      expect.objectContaining({ role: 'assistant', text: 'Hello back' }),
    ]);
    expect(ws.last('agent-turn-end')).toMatchObject({ taskId: request.taskId, status: 'done' });
    expect((await state()).loopActive).toBe(false);
  });

  it('refuses direct commands and unsolicited chat without executing or storing them', async () => {
    const ws = await bootConnected();
    for (const method of ['open', 'describe', 'step', 'stop']) {
      ws.receive({ type: 'req', id: 2, method, params: { url: 'https://example.com' } });
      await flush();
      expect(ws.last('error')).toMatchObject({ code: 'UNKNOWN_METHOD' });
    }
    ws.receive({ type: 'chat', text: 'Unexpected answer' });
    await flush();
    expect((await state()).chat).toEqual([]);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.createTask).not.toHaveBeenCalled();
  });

  it('requires a successful handshake before sending, with no protocol fallback', async () => {
    startRemoteBackground();
    await flush();
    const ws = sockets[0]!;
    ws.open();
    await flush();
    expect((await ask({ type: 'remote-chat-send', text: 'Hello' })).ok).toBe(false);
    ws.receive({ type: 'ready', capabilities: [] });
    await flush();
    expect(ws.readyState).toBe(3);
    expect((await state()).error).toBe('ui.error.protocolMismatch');
    await vi.advanceTimersByTimeAsync(120000);
    expect(sockets).toHaveLength(1);
    expect(ws.last('chat')).toBeUndefined();
  });

  it('times out a missing handshake and retains a useful error', async () => {
    startRemoteBackground();
    await flush();
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(10001);
    expect((await state()).error).toBe('ui.error.protocolMismatch');
    expect((await state()).connected).toBe(false);
  });

  it('records actions, returns observations, and completes once for an identical decision retry', async () => {
    const ws = await bootConnected();
    const request = await selectPage(ws);
    const decision = { kind: 'actions', actions: [{ method: 'click', params: { x: 10, y: 10 } }] };
    await respond(ws, request, decision);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(ws.last('agent-request')).toMatchObject({ round: 3 });
    await respond(ws, request, decision, 2);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const next = ws.last('agent-request')!;
    await respond(ws, next, { kind: 'done', text: 'Done' }, 3);
    expect((await state()).task).toBeNull();
    const history = (await state()).chat as ChatEntry[];
    expect(history.find((m) => m.toolRun)?.toolRun).toMatchObject({
      status: 'completed',
      total: 2,
    });
    expect(ws.frames.some((f) => f.type === 'agent-event' && f.phase === 'end')).toBe(true);
    expect(JSON.stringify(storage.remoteChatLog)).not.toContain('fresh state');
  });

  it('keeps heartbeats responsive during an action and stops late continuation', async () => {
    const ws = await bootConnected();
    const request = await selectPage(ws);
    let resolve!: (v: { ran: string }) => void;
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await respond(ws, request, {
      kind: 'actions',
      actions: [{ method: 'click', params: { x: 1, y: 2 } }],
    });
    ws.receive({ type: 'ping', ts: 123 });
    await flush();
    expect(ws.last('pong')).toEqual({ type: 'pong', ts: 123 });
    await ask({ type: 'remote-stop' });
    expect(executor.release).toHaveBeenCalledOnce();
    resolve({ ran: 'click' });
    await flush();
    expect(ws.last('agent-request')!.id).toBe(request.id);
    expect(ws.last('agent-turn-end')).toMatchObject({ status: 'stopped' });
    await respond(ws, request, { kind: 'done', text: 'Too late' }, 2);
    expect(ws.last('error')).toMatchObject({ code: 'DECISION_CONFLICT' });
  });

  it('clearing history cannot be undone by a late action or scheduled write', async () => {
    const ws = await bootConnected();
    const request = await selectPage(ws);
    let resolve!: (v: { ran: string }) => void;
    executor.execute.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await respond(ws, request, {
      kind: 'actions',
      actions: [{ method: 'click', params: { x: 1, y: 2 } }],
    });
    await ask({ type: 'remote-chat-clear' });
    resolve({ ran: 'click' });
    await vi.advanceTimersByTimeAsync(500);
    expect(storage.remoteChatLog).toEqual([]);
  });

  it('shows correlated delivery failures and ignores stale receipts', async () => {
    const ws = await bootConnected();
    const request = await begin(ws);
    ws.receive({ type: 'agent-status', requestId: 'other', state: 'failed' });
    await flush();
    expect((storage.remoteChatLog as ChatEntry[])[0]!.delivery).toBe('sent');
    ws.receive({ type: 'agent-status', requestId: request.id, state: 'queued' });
    await flush();
    expect((storage.remoteChatLog as ChatEntry[])[0]!.delivery).toBe('queued');
    ws.receive({
      type: 'agent-status',
      requestId: request.id,
      state: 'failed',
      code: 'AGENT_UNAVAILABLE',
    });
    await flush();
    expect((storage.remoteChatLog as ChatEntry[])[0]).toMatchObject({
      delivery: 'failed',
      deliveryError: 'ui.error.agentUnavailable',
    });
  });

  it('disconnect ends the turn, reconnect negotiates again, and a replaced connection stays closed', async () => {
    const ws = await bootConnected();
    await begin(ws);
    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect((storage.remoteChatLog as ChatEntry[])[0]!.loopStatus).toBe('interrupted');
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.receive({
      type: 'ready',
      capabilities: ['agent-loop-v1', 'browser-instance-v1'],
      endpointId: `abababababab.${storage.remoteBrowserId}`,
    });
    await flush();
    expect(sockets[1]!.last('agent-request')).toBeUndefined();
    sockets[1]!.serverClose(4001);
    await vi.advanceTimersByTimeAsync(120000);
    expect(sockets).toHaveLength(2);
    expect((await state()).error).toBe('ui.error.connectionTaken');
  });

  it('persists the final answer even when task cleanup fails', async () => {
    const ws = await bootConnected();
    const request = await begin(ws);
    executor.completeTask.mockRejectedValueOnce(new Error('detach failed'));
    await respond(ws, request, { kind: 'done', text: 'Result' });
    expect((await state()).error).toBe('ui.error.taskCleanupFailed');
    expect((storage.remoteChatLog as ChatEntry[]).at(-1)!.text).toBe('Result');
  });

  it('does not report completed delivery when final answer persistence fails', async () => {
    const ws = await bootConnected();
    const request = await begin(ws);
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('full'));
    await respond(ws, request, { kind: 'done', text: 'Result' });
    expect(ws.last('agent-turn-end')).toMatchObject({ status: 'interrupted' });
    expect((await state()).error).toBe('ui.error.chatSaveFailed');
  });

  it('kill switch releases the task and saving new settings connects with the new key', async () => {
    const ws = await bootConnected();
    await begin(ws);
    await ask({ type: 'remote-set-enabled', enabled: false });
    expect(ws.readyState).toBe(3);
    expect(executor.release).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120000);
    expect(sockets).toHaveLength(1);
    await ask({ type: 'remote-save', relayUrl: 'wss://other.example/ext', key: 'b'.repeat(64) });
    await ask({ type: 'remote-set-enabled', enabled: true });
    await flush();
    expect(sockets[1]!.protocols[1]).toBe(`key.${'b'.repeat(64)}`);
  });

  it('does not dial without configuration', async () => {
    storage = {};
    startRemoteBackground();
    await flush();
    expect(sockets).toHaveLength(0);
  });
});
