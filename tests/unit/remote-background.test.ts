// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executor = vi.hoisted(() => ({
  attach: vi.fn(),
  release: vi.fn(async () => {}),
  currentControl: vi.fn((): null | { sessionId: string; tabId: number; tabIds: number[] } => null),
  currentGrant: vi.fn(() => null),
  execute: vi.fn(async (c: { op: string }) => ({ ran: c.op })),
  onState: vi.fn(),
  initializeExecutor: vi.fn(),
  revealTask: vi.fn(async () => {}),
}));
vi.mock('../../utils/automation/executor', () => executor);
vi.mock('../../utils/automation/task-lifecycle', () => ({ recoverTasks: vi.fn(async () => {}) }));
vi.mock('../../utils/messages', () => ({ isPanelSender: () => true }));

import { startRemoteBackground } from '../../entrypoints/background/remote';
import { REMOTE_SUBPROTOCOL } from '../../utils/remote';

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
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('crypto', {
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    subtle: { digest: async () => new Uint8Array(32).fill(0xab).buffer },
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'x'.repeat(32),
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
    tabs: { query: vi.fn(async () => [{ id: 3, windowId: 1 }]) },
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
    expect(executor.attach).toHaveBeenCalled();
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
    expect(st.value?.error).toMatch(/接管/);
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
