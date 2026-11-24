// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const capture = vi.hoisted(() => ({ emit: undefined as undefined | ((event: unknown) => void) }));
vi.mock('../../utils/diagnostics-runtime', () => ({
  installRuntimeDiagnostics: (emit: (event: unknown) => void) => {
    capture.emit = emit;
  },
}));
let listener: (message: unknown) => void;
let pending: (() => void)[];
let sent: any[];
let startup: any[];
beforeEach(() => {
  vi.resetModules();
  pending = [];
  sent = [];
  startup = [];
  capture.emit = undefined;
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (fn: typeof listener) => {
          listener = fn;
        },
      },
      sendMessage: vi.fn(async (message: any) => {
        if (message.type === 'remote-state')
          return { ok: true, value: { diagnosticsEnabled: false } };
        // Startup timing marks are covered separately; keep queue assertions exact.
        if (message.event?.event === 'startup-mark') {
          startup.push(message.event);
          return { ok: true, value: { accepted: true } };
        }
        sent.push(message);
        await new Promise<void>((resolve) => {
          pending.push(resolve);
        });
        return { ok: true, value: { accepted: true } };
      }),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps a synchronous invalidated-context failure from escaping the caller', async () => {
  vi.useFakeTimers();
  const d = await import('../../utils/diagnostics-panel');
  d.startPanelDiagnostics();
  await flush();
  listener({
    type: 'remote-updated',
    state: { diagnosticsEnabled: true, diagnosticsConsent: 'token-a' },
  });
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => {
    throw new Error('PRIVATE_INVALIDATED');
  });
  expect(() => d.reportPanelDiagnostic({ event: 'runtime-error', level: 'error' })).not.toThrow();
  await flush();
  listener({ type: 'remote-updated', state: { diagnosticsEnabled: false } });
});
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

it('records panel visibility only while diagnostics consent is active', async () => {
  const documentEvents = new EventTarget();
  vi.stubGlobal('document', Object.assign(documentEvents, { visibilityState: 'visible' }));
  vi.stubGlobal('window', new EventTarget());
  const d = await import('../../utils/diagnostics-panel');
  d.startPanelDiagnostics();
  await flush();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(sent).toHaveLength(0);
  listener({
    type: 'remote-updated',
    state: { diagnosticsEnabled: true, diagnosticsConsent: 'token-a' },
  });
  expect(sent.at(-1).event).toMatchObject({ event: 'panel-visibility', visibility: 'visible' });
  Object.assign(document, { visibilityState: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(sent.at(-1).event).toMatchObject({ event: 'panel-visibility', visibility: 'hidden' });
  listener({ type: 'remote-updated', state: { diagnosticsEnabled: false } });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(sent).toHaveLength(2);
  for (const done of pending) done();
  await flush();
});

it('collects only after consent and reports bounded queue overflow without payloads', async () => {
  const d = await import('../../utils/diagnostics-panel');
  d.startPanelDiagnostics();
  await flush();
  capture.emit!({ event: 'console', level: 'warn', argCount: 1 });
  expect(sent).toHaveLength(0);
  listener({
    type: 'remote-updated',
    state: { diagnosticsEnabled: true, diagnosticsConsent: 'token-a' },
  });
  await flush(); // Let the startup mark sent on consent settle.
  for (let i = 0; i < 25; i++) capture.emit!({ event: 'console', level: 'warn', argCount: 1 });
  expect(sent).toHaveLength(20);
  pending.shift()!();
  await flush();
  expect(sent).toHaveLength(21);
  expect(sent.at(-1)).toMatchObject({
    type: 'remote-diagnostics-event',
    consent: 'token-a',
    event: { event: 'capture-overflow', count: 5 },
  });
  for (const done of pending) done();
  await flush();
});

it('does not send an old queued loss report after off/re-enable', async () => {
  const d = await import('../../utils/diagnostics-panel');
  d.startPanelDiagnostics();
  await flush();
  listener({
    type: 'remote-updated',
    state: { diagnosticsEnabled: true, diagnosticsConsent: 'token-a' },
  });
  await flush(); // Let the startup mark sent on consent settle.
  for (let i = 0; i < 25; i++) capture.emit!({ event: 'console', level: 'warn' });
  listener({ type: 'remote-updated', state: { diagnosticsEnabled: false } });
  listener({
    type: 'remote-updated',
    state: { diagnosticsEnabled: true, diagnosticsConsent: 'token-b' },
  });
  for (const done of pending) done();
  await flush();
  expect(sent).toHaveLength(20);
  capture.emit!({ event: 'console', level: 'info' });
  expect(sent.at(-1).consent).toBe('token-b');
  pending.at(-1)!();
  await flush();
});

it('holds panel startup marks until consent, then sends names and durations only', async () => {
  const d = await import('../../utils/diagnostics-panel');
  d.startPanelDiagnostics();
  await flush();
  d.markPanelStartup('panel-first-render');
  d.markPanelStartup('panel-first-render');
  expect(startup).toHaveLength(0);
  listener({
    type: 'remote-updated',
    state: { diagnosticsEnabled: true, diagnosticsConsent: 'token-a' },
  });
  await flush();
  expect(startup.map((e) => e.mark).sort()).toEqual(['panel-first-render', 'panel-state-received']);
  for (const event of startup) {
    expect(Object.keys(event).sort()).toEqual(['delayMs', 'event', 'level', 'mark']);
    expect(Number.isInteger(event.delayMs)).toBe(true);
  }
  for (const done of pending) done();
  await flush();
});
