// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../utils/automation/executor', () => ({
  initializeExecutor: vi.fn(),
  onState: vi.fn(),
  configureControlRecovery: vi.fn(),
  currentControl: () => null,
  currentGrant: () => null,
  diagnosticNavigationRevision: () => 0,
  completeTask: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  abortControlRecovery: vi.fn(),
}));
vi.mock('../../utils/automation/task-lifecycle', () => ({ recoverTasks: vi.fn(async () => {}) }));
vi.mock('../../utils/messages', () => ({ isPanelSender: () => true }));
import { startRemoteBackground } from '../../entrypoints/background/remote';

let sockets: Socket[];
let handler: (m: unknown, s: unknown, reply: (r: any) => void) => void;
let alarm: (a: { name: string }) => void;
let storage: Record<string, any>;
class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  onopen?: () => void;
  onclose?: (e: { code: number }) => void;
  onmessage?: (e: { data: string }) => void;
  onerror?: () => void;
  send = vi.fn();
  // A half-open transport never acknowledges close locally.
  close = vi.fn();
  constructor() {
    sockets.push(this);
  }
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.receive({
      type: 'ready',
      capabilities: ['agent-loop-v1', 'browser-instance-v1', 'agent-message-v2'],
      endpointId: `abababababab.${storage.remoteBrowserId}`,
    });
  }
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const ask = (m: unknown): Promise<any> => new Promise((resolve) => handler(m, {}, resolve));
const state = async () => (await ask({ type: 'remote-state' })).value;
beforeEach(async () => {
  vi.useFakeTimers();
  sockets = [];
  storage = {
    remoteConfig: { relayUrl: 'wss://agent.example/ext', key: 'a'.repeat(64), enabled: true },
  };
  vi.stubGlobal('WebSocket', Socket);
  let id = 0;
  vi.stubGlobal('crypto', {
    randomUUID: () => `11111111-1111-4111-8111-${String(++id).padStart(12, '0')}`,
    subtle: { digest: async () => new Uint8Array(32).fill(0xab).buffer },
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'x'.repeat(32),
      getManifest: () => ({ version: '0.17.1' }),
      onConnect: { addListener: vi.fn() },
      sendMessage: vi.fn(async () => {}),
      onMessage: {
        addListener: (h: typeof handler) => {
          handler = h;
        },
      },
    },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      local: {
        setAccessLevel: async () => {},
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter((k) => k in storage).map((k) => [k, storage[k]])),
        set: async (v: object) => {
          Object.assign(storage, v);
        },
      },
    },
    alarms: {
      create: vi.fn(),
      onAlarm: {
        addListener: (h: typeof alarm) => {
          alarm = h;
        },
      },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    windows: { getLastFocused: async () => ({ id: 1, incognito: false }) },
    debugger: { onEvent: { addListener: vi.fn() }, sendCommand: async () => {} },
    tabs: { query: async () => [], onRemoved: { addListener: vi.fn() } },
  });
  startRemoteBackground();
  await flush();
  sockets[0]!.open();
  await flush();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('invalidates a half-open socket without waiting for close and ignores its late callbacks', async () => {
  const old = sockets[0]!;
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await state()).connected).toBe(false);
  expect(old.close).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1600);
  const next = sockets[1]!;
  next.open();
  await flush();
  old.onclose?.({ code: 4001 });
  old.receive({ type: 'ping', ts: 1 });
  old.onerror?.();
  expect((await state()).connected).toBe(true);
  expect(next.send.mock.calls.map((c) => JSON.parse(c[0])).some((f) => f.type === 'pong')).toBe(
    false,
  );
});
it('abandons a reconnect whose upgrade never completes and tries again', async () => {
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.advanceTimersByTimeAsync(1600);
  const pinned = sockets[1]!;
  expect(pinned.readyState).toBe(0);
  await vi.advanceTimersByTimeAsync(14_000);
  expect(pinned.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(pinned.close).toHaveBeenCalled();
  expect((await state()).connecting).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sockets.length).toBeGreaterThan(2);
  pinned.onopen?.();
  pinned.onclose?.({ code: 1006 });
  sockets.at(-1)!.open();
  await flush();
  expect((await state()).connected).toBe(true);
});
it('keeps recent valid inbound traffic alive', async () => {
  for (let n = 0; n < 5; n++) {
    await vi.advanceTimersByTimeAsync(17_000);
    sockets[0]!.receive({ type: 'ping', ts: Date.now() });
    await flush();
  }
  expect((await state()).connected).toBe(true);
  expect(sockets[0]!.close).not.toHaveBeenCalled();
});
it('checks elapsed time on alarm after suspension even if timers did not fire', async () => {
  vi.setSystemTime(Date.now() + 90_000);
  alarm({ name: 'remote-keepalive' });
  await flush();
  expect((await state()).connected).toBe(false);
  expect(sockets[0]!.close).toHaveBeenCalled();
});
it('does not reconnect after explicitly disabling the transport', async () => {
  await ask({ type: 'remote-set-enabled', enabled: false });
  await vi.advanceTimersByTimeAsync(90_000);
  alarm({ name: 'remote-keepalive' });
  await flush();
  expect(sockets).toHaveLength(1);
  expect((await state()).connected).toBe(false);
});
