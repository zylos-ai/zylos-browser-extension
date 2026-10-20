import { afterEach, expect, it, vi } from 'vitest';
import {
  frameDiagnosticProbe,
  startFrameDiagnostics,
} from '../../utils/automation/iframe-diagnostics';

const keys: string[] = [];
const mockChrome = (executeScript: any) =>
  vi.stubGlobal('chrome', {
    scripting: { executeScript },
    tabs: { get: vi.fn(async () => ({ id: 12, windowId: 1, url: 'https://example.test/' })) },
    webNavigation: {
      getFrame: vi.fn(async () => ({ documentId: 'document-1', url: 'https://example.test/' })),
    },
  });
const start = () => {
  const key = `test-${crypto.randomUUID()}`;
  keys.push(key);
  frameDiagnosticProbe(key, 'start');
  return key;
};
const mutations = async () => {
  await Promise.resolve();
};
afterEach(() => {
  for (const key of keys.splice(0)) frameDiagnosticProbe(key, 'stop');
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('records only scheme categories and stable document-local integer identities', async () => {
  const key = start();
  const frame = document.createElement('iframe');
  frame.src = 'chrome-extension://PRIVATE_ID/PRIVATE_PATH?token=PRIVATE';
  document.body.append(frame);
  await mutations();
  expect(frameDiagnosticProbe(key, 'drain')).toEqual([
    { event: 'iframe-added', frame: 1, scheme: 'extension', observedAt: expect.any(Number) },
  ]);
  frame.src = 'https://PRIVATE.example/secret';
  await mutations();
  expect(frameDiagnosticProbe(key, 'drain')).toEqual([
    { event: 'iframe-src', frame: 1, scheme: 'https', observedAt: expect.any(Number) },
  ]);
  frame.remove();
  await mutations();
  expect(frameDiagnosticProbe(key, 'drain')).toEqual([
    { event: 'iframe-removed', frame: 1, scheme: 'https', observedAt: expect.any(Number) },
  ]);
});

it('bounds buffer and frame identities under a mutation flood', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const key = start();
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 300; i++) fragment.append(document.createElementNS('urn:test', 'iframe'));
  document.body.append(fragment);
  await mutations();
  const batch = frameDiagnosticProbe(key, 'drain');
  expect(batch.filter((event) => event.event === 'iframe-added')).toHaveLength(64);
  expect(batch).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: 'iframe-status', status: 'buffer-overflow' }),
      expect.objectContaining({ event: 'iframe-status', status: 'frame-cap' }),
    ]),
  );
  const frame = document.createElement('iframe');
  document.body.append(frame);
  await mutations();
  expect(frameDiagnosticProbe(key, 'drain')).toEqual([
    { event: 'iframe-status', status: 'frame-cap', observedAt: expect.any(Number) },
  ]);
});

it('retains same-scheme src mutations without retaining URLs', async () => {
  const key = start();
  const frame = document.createElementNS('urn:test', 'iframe');
  frame.setAttribute('src', 'chrome-extension://PRIVATE_ONE/first');
  document.body.append(frame);
  await mutations();
  frameDiagnosticProbe(key, 'drain');
  frame.setAttribute('src', 'chrome-extension://PRIVATE_TWO/second');
  await mutations();
  const batch = frameDiagnosticProbe(key, 'drain');
  expect(batch).toEqual([
    { event: 'iframe-src', frame: 1, scheme: 'extension', observedAt: expect.any(Number) },
  ]);
  expect(JSON.stringify(batch)).not.toContain('PRIVATE');
});

it('expires without background cleanup and does not observe after stop', async () => {
  vi.useFakeTimers();
  const key = start();
  await vi.advanceTimersByTimeAsync(120_000);
  document.body.append(document.createElement('iframe'));
  await mutations();
  expect(frameDiagnosticProbe(key, 'drain')).toEqual([
    { event: 'iframe-status', status: 'unavailable', observedAt: expect.any(Number) },
  ]);
  expect((globalThis as any)[key]).toBeUndefined();
});

it('uses pinned isolated injection and reports when injection is denied', async () => {
  vi.useFakeTimers();
  const executeScript = vi.fn().mockRejectedValue(new Error('denied'));
  mockChrome(executeScript);
  const emit = vi.fn();
  startFrameDiagnostics(12, () => true, emit);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(executeScript.mock.calls[0]?.[0]).toMatchObject({
    target: { tabId: 12, documentIds: ['document-1'] },
    world: 'ISOLATED',
  });
  expect(emit).toHaveBeenCalledWith({
    event: 'iframe-status',
    status: 'unavailable',
    observedAt: expect.any(Number),
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('cleans up an installation that completes after cancellation', async () => {
  vi.useFakeTimers();
  let resolveStart!: (value: any[]) => void;
  const executeScript = vi.fn(({ args }: any) =>
    args[1] === 'start'
      ? new Promise<any[]>((resolve) => {
          resolveStart = resolve;
        })
      : Promise.resolve([{ frameId: 0, documentId: 'document-1', result: [] }]),
  );
  mockChrome(executeScript);
  const emit = vi.fn();
  const stop = startFrameDiagnostics(12, () => true, emit);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  await vi.advanceTimersByTimeAsync(0);
  const before = executeScript.mock.calls.length;
  resolveStart([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(executeScript.mock.calls.slice(before).map(([call]) => call.args[1])).toEqual(['stop']);
  expect(vi.getTimerCount()).toBe(0);
  expect(emit).not.toHaveBeenCalled();
});

it('final drain survives grant release but drops data when consent is revoked', async () => {
  vi.useFakeTimers();
  let pending: any[] = [];
  const executeScript = vi.fn(async ({ args }: any) => [
    { frameId: 0, documentId: 'document-1', result: args[1] === 'drain' ? pending.splice(0) : [] },
  ]);
  mockChrome(executeScript);
  let current = true;
  let consent = true;
  const emit = vi.fn();
  const stop = startFrameDiagnostics(
    12,
    () => current,
    emit,
    () => consent,
  );
  await vi.advanceTimersByTimeAsync(0);
  pending = [
    { event: 'iframe-added', frame: 1, scheme: 'extension', observedAt: 123, url: 'PRIVATE' },
  ];
  current = false;
  stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(emit).toHaveBeenCalledWith({
    event: 'iframe-added',
    frame: 1,
    scheme: 'extension',
    observedAt: 123,
  });
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE');
  current = true;
  const stop2 = startFrameDiagnostics(
    12,
    () => current,
    emit,
    () => consent,
  );
  await vi.advanceTimersByTimeAsync(0);
  pending = [{ event: 'iframe-added', frame: 2, scheme: 'extension', observedAt: 456 }];
  consent = false;
  stop2();
  await vi.advanceTimersByTimeAsync(0);
  expect(emit).toHaveBeenCalledTimes(1);
});

it('refuses restricted pages and same-URL replacement documents before installation', async () => {
  vi.useFakeTimers();
  const executeScript = vi.fn(async () => []);
  mockChrome(executeScript);
  vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
    id: 12,
    windowId: 1,
    url: 'chrome://settings/',
  } as any);
  const emit = vi.fn();
  startFrameDiagnostics(12, () => true, emit);
  await vi.advanceTimersByTimeAsync(0);
  expect(executeScript).not.toHaveBeenCalled();
  vi.mocked(chrome.webNavigation.getFrame)
    .mockResolvedValueOnce({ documentId: 'old', url: 'https://example.test/' } as any)
    .mockResolvedValueOnce({ documentId: 'new', url: 'https://example.test/' } as any);
  startFrameDiagnostics(12, () => true, emit);
  await vi.advanceTimersByTimeAsync(0);
  expect(executeScript).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledTimes(2);
});

it('reports scan budget limits and captures timestamps before delayed drain', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.spyOn(Date, 'now').mockReturnValue(1234);
  const key = start();
  const fragment = document.createDocumentFragment();
  fragment.append(document.createElementNS('urn:test', 'iframe'));
  for (let i = 0; i < 600; i++) fragment.append(document.createElement('span'));
  document.body.append(fragment);
  await mutations();
  vi.mocked(Date.now).mockReturnValue(5678);
  const batch = frameDiagnosticProbe(key, 'drain');
  expect(batch).toEqual(
    expect.arrayContaining([
      { event: 'iframe-added', frame: 1, scheme: 'about', observedAt: 1234 },
      { event: 'iframe-status', status: 'scan-budget', observedAt: 1234 },
    ]),
  );
});

it('reports expiry even when no iframe mutations occur', async () => {
  vi.useFakeTimers();
  mockChrome(vi.fn(async () => [{ frameId: 0, documentId: 'document-1', result: [] }]));
  const emit = vi.fn();
  startFrameDiagnostics(12, () => true, emit);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(emit).toHaveBeenCalledWith({
    event: 'iframe-status',
    status: 'expired',
    observedAt: expect.any(Number),
  });
  expect(vi.getTimerCount()).toBe(0);
});
