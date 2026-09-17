import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { LivePreview } from '../../utils/automation/live-preview';
import { PREVIEW_PORT, type PreviewState } from '../../utils/live-preview';
import type { Scope } from '../../utils/automation/types';

let connect: (port: unknown) => void;
let event: (source: object, method: string, params?: object) => void;
let removed: (id: number) => void;
let service: LivePreview;
let command: ReturnType<typeof vi.fn>;
const scope = (tabId = 3, sessionId = 'task-1'): Scope => ({
  scope: 'task',
  phase: 'ready',
  windowId: 1,
  sessionId,
  tabId,
  tabIds: [tabId],
  groupId: null,
});
const grant = (id = 3, url = 'https://example.com/') => ({
  id,
  windowId: 1,
  url,
  title: 'Example',
});
const tick = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
function client(trusted = true) {
  let message: (message: unknown) => void = () => {};
  let disconnect: () => void = () => {};
  const sent: any[] = [];
  const port = {
    name: PREVIEW_PORT,
    sender: {
      id: 'extension',
      url: trusted ? 'chrome-extension://extension/sidepanel.html' : 'https://example.com/',
    },
    postMessage: vi.fn((value: unknown) => sent.push(structuredClone(value))),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (fn: typeof message) => {
        message = fn;
      },
    },
    onDisconnect: {
      addListener: (fn: typeof disconnect) => {
        disconnect = fn;
      },
    },
  };
  connect(port);
  return {
    port,
    sent,
    visible: (visible: boolean) => message({ type: 'visibility', visible }),
    ack: (sequence: number) => message({ type: 'ack', sequence }),
    disconnect: () => disconnect(),
    state: (): PreviewState => sent.filter((m) => m.type === 'preview-state').at(-1)?.preview,
    frames: () => sent.filter((m) => m.type === 'preview-frame').map((m) => m.frame),
  };
}
function frame(id = 1, tabId = 3, data = 'YWJj') {
  event({ tabId }, 'Page.screencastFrame', { sessionId: id, data });
}
beforeEach(() => {
  vi.useFakeTimers();
  command = vi.fn(async () => ({}));
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension',
      getURL: (p: string) => `chrome-extension://extension/${p}`,
      onConnect: {
        addListener: (fn: typeof connect) => {
          connect = fn;
        },
      },
    },
    debugger: {
      sendCommand: command,
      onEvent: {
        addListener: (fn: typeof event) => {
          event = fn;
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener: (fn: typeof removed) => {
          removed = fn;
        },
      },
      get: vi.fn(async (id: number) => ({ id, windowId: 1, groupId: 4 })),
      update: vi.fn(async () => ({})),
    },
    windows: { update: vi.fn(async () => ({})) },
    tabGroups: { update: vi.fn(async () => ({})) },
  });
  service = new LivePreview();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('only visible authenticated side panels start capture; hide/disconnect stops it', async () => {
  service.sync(scope(), grant(), true);
  await tick();
  expect(command).not.toHaveBeenCalled();
  const rejected = client(false);
  expect(rejected.port.disconnect).toHaveBeenCalledOnce();
  const a = client();
  const b = client();
  a.visible(true);
  b.visible(true);
  await tick();
  expect(command.mock.calls.filter((c) => c[1] === 'Page.startScreencast')).toHaveLength(1);
  a.visible(false);
  await tick();
  expect(command.mock.calls.filter((c) => c[1] === 'Page.stopScreencast')).toHaveLength(0);
  b.disconnect();
  await tick();
  expect(command).toHaveBeenLastCalledWith({ tabId: 3 }, 'Page.stopScreencast', undefined);
  a.visible(true);
  await tick();
  expect(command.mock.calls.filter((c) => c[1] === 'Page.startScreencast')).toHaveLength(2);
  expect(
    command.mock.calls.every(
      (c) => c[1].startsWith('Page.') && !c[1].includes('captureScreenshot'),
    ),
  ).toBe(true);
});

test('acks CDP promptly, bounds client backlog and delivers the last throttled frame', async () => {
  const a = client();
  a.visible(true);
  service.sync(scope(), grant(), true);
  await tick();
  frame(1);
  frame(2, 3, 'ZGVm');
  expect(command.mock.calls.filter((c) => c[1] === 'Page.screencastFrameAck')).toHaveLength(2);
  expect(a.frames()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(150);
  expect(a.frames()).toHaveLength(1); // slow panel has not consumed frame 1
  a.ack(a.frames()[0].sequence);
  await vi.advanceTimersByTimeAsync(100);
  expect(a.frames()).toHaveLength(2);
  expect(a.frames()[1].dataUrl).toBe('data:image/jpeg;base64,ZGVm');
  a.ack(a.frames()[1].sequence);
  service.finish('completed');
  await tick();
  expect(a.frames()).toHaveLength(2);
  expect(a.state().status).toBe('completed');
  expect(a.state()).not.toHaveProperty('dataUrl');
  frame(3);
  expect(a.frames()).toHaveLength(2);
  const b = client();
  b.visible(true);
  await tick();
  expect(b.frames()[0].dataUrl).toBe('data:image/jpeg;base64,ZGVm');
  expect(b.state().canStop).toBe(false);
});

test('target changes discard old frames, stop old capture and never follow unrelated tabs', async () => {
  const a = client();
  a.visible(true);
  service.sync(scope(), grant(), true);
  await tick();
  frame();
  const firstKey = a.state().targetKey;
  a.ack(a.frames()[0].sequence);
  service.sync(scope(4), grant(4), true);
  await tick();
  expect(a.state().targetKey).not.toBe(firstKey);
  const count = a.frames().length;
  frame(2, 3);
  expect(a.frames()).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(100);
  frame(3, 4);
  expect(a.frames().at(-1).targetKey).toBe(a.state().targetKey);
  expect(command.mock.calls.some((c) => c[0].tabId === 3 && c[1] === 'Page.stopScreencast')).toBe(
    true,
  );
  const key = a.state().targetKey;
  service.sync(scope(4), grant(4, 'https://example.com/next'), true);
  await tick();
  expect(a.state().targetKey).not.toBe(key);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});

test('a pending start is stopped before starting a replacement target', async () => {
  let complete!: () => void;
  command.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        complete = r;
      }),
  );
  const a = client();
  a.visible(true);
  service.sync(scope(), grant(), true);
  await tick();
  service.sync(scope(4), grant(4), true);
  complete();
  await tick();
  expect(command.mock.calls.map((c) => [c[0].tabId, c[1]])).toEqual([
    [3, 'Page.startScreencast'],
    [3, 'Page.stopScreencast'],
    [4, 'Page.startScreencast'],
  ]);
});

test.each(['stopped', 'interrupted'] as const)(
  '%s cannot become a green success after a late final',
  async (status) => {
    const a = client();
    a.visible(true);
    service.sync(scope(), grant(), true);
    await tick();
    service.finish(status);
    service.sync(null, null, true);
    service.finish('completed');
    await tick();
    expect(a.state().status).toBe(status);
    expect(a.state().canStop).toBe(false);
    service.resume('snapshot');
    service.sync(scope(), grant(), true);
    service.result('snapshot', false);
    service.finish('completed');
    expect(a.state().status).toBe('completed');
    service.finish('interrupted');
    expect(a.state().status).toBe('completed');
  },
);

test('a failed action is not a success; unavailable frames retain stop and reveal', async () => {
  command.mockRejectedValueOnce(new Error('unsupported'));
  const a = client();
  a.visible(true);
  service.sync(scope(), grant(), true);
  await tick();
  expect(a.state()).toMatchObject({ availability: 'unavailable', canStop: true, canReveal: true });
  service.sync(scope(), grant(), true);
  await tick();
  expect(command).toHaveBeenCalledOnce();
  service.result('click', true);
  service.result('finish', false);
  expect(a.state().status).toBe('error');
});

test('no-frame timeout is explicit and a later real frame recovers', async () => {
  const a = client();
  a.visible(true);
  service.sync(scope(), grant(), true);
  await tick();
  await vi.advanceTimersByTimeAsync(5000);
  expect(a.state().availability).toBe('unavailable');
  frame();
  expect(a.state().availability).toBe('live');
});

test('reveal uses the retained original tab; closed tabs cannot be recreated or reopened', async () => {
  const a = client();
  a.visible(true);
  service.sync(scope(), grant(), true);
  await tick();
  service.finish('completed');
  service.sync(null, null, true);
  await service.reveal();
  expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
  removed(3);
  expect(a.state().canReveal).toBe(false);
  await expect(service.reveal()).rejects.toThrow('previewTabClosed');
  service.clear();
  expect(a.state()).toBeNull();
});

test('disconnect retains local Stop while control exists, then an explicit stop clears it', async () => {
  const a = client();
  a.visible(true);
  service.sync(scope(), grant(), true);
  await tick();
  service.finish('interrupted');
  service.sync(scope(), grant(), false);
  expect(a.state()).toMatchObject({ status: 'interrupted', canStop: true });
  service.finish('completed');
  expect(a.state().status).toBe('interrupted');
  service.finish('stopped');
  service.sync(null, null, false);
  expect(a.state()).toMatchObject({ status: 'stopped', canStop: false });
});
