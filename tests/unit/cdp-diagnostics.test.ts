// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../../utils/automation/iframe-diagnostics', () => ({
  startFrameDiagnostics: vi.fn(() => vi.fn()),
}));
import {
  configureCdpDiagnostics,
  diagnosticSend,
  diagnosticAttach,
  diagnosticDetach,
  setDiagnosticTarget,
  recordDebuggerEvent,
  refreshCdpDiagnostics,
} from '../../utils/automation/cdp-diagnostics';
import { startFrameDiagnostics } from '../../utils/automation/iframe-diagnostics';
let token: string;
let task: number;
let events: any[];
beforeEach(() => {
  token = crypto.randomUUID();
  task = 1;
  events = [];
  configureCdpDiagnostics({
    capture: () => (token ? { token, context: { task, operation: 5 } } : undefined),
    valid: (lease) => lease.token === token && lease.context.task === task,
    emit: (lease, event) => {
      events.push({ lease, event });
    },
    secrets: () => ['PRIVATE_SECRET'],
  });
  setDiagnosticTarget(() => ({ tabId: 42, controlled: true, granted: true, borrowed: true }));
  vi.stubGlobal('chrome', {
    debugger: {
      sendCommand: vi.fn(async () => ({ privateResult: 'VALUE' })),
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      getTargets: vi.fn(async () => []),
    },
    tabs: { get: vi.fn(async () => ({ id: 42, discarded: false })) },
  });
});
afterEach(() => vi.useRealTimers());
it('does not capture when disabled and preserves the command result', async () => {
  token = '';
  expect(
    await diagnosticSend({ tabId: 42 }, 'Runtime.evaluate', { expression: 'PRIVATE' }),
  ).toEqual({ privateResult: 'VALUE' });
  expect(events).toEqual([]);
});
it('captures paired method metadata without command arguments, result values or raw IDs', async () => {
  await diagnosticSend({ tabId: 42, sessionId: 'RAW_SESSION' }, 'Runtime.evaluate', {
    expression: 'PRIVATE_ARG',
  });
  expect(events).toHaveLength(2);
  const text = JSON.stringify(events);
  expect(text).toContain('Runtime.evaluate');
  for (const secret of ['PRIVATE_ARG', 'VALUE', 'RAW_SESSION', '"tab":42'])
    expect(text).not.toContain(secret);
  expect(events[0].lease.context).toEqual({ task: 1, operation: 5 });
});
it('preserves native error identity and records sanitized error before rethrow', async () => {
  const error = new Error('Detached while handling command. PRIVATE_SECRET');
  vi.mocked(chrome.debugger.sendCommand).mockRejectedValue(error);
  await expect(diagnosticSend({ tabId: 42 }, 'Runtime.callFunctionOn')).rejects.toBe(error);
  expect(events[1].event.text).toContain('Detached while handling command.');
  expect(events[1].event.text).not.toContain('PRIVATE_SECRET');
});
it.each(['consent', 'task'])(
  'drops asynchronous completion after %s scope changes',
  async (change) => {
    let resolve!: (value: object) => void;
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const result = diagnosticSend({ tabId: 42 }, 'Page.enable');
    if (change === 'consent') token = 'new-consent';
    else task = 2;
    resolve({});
    await result;
    expect(events).toHaveLength(1);
  },
);
it('diagnostic sink errors cannot change a browser action', async () => {
  configureCdpDiagnostics({
    capture: () => {
      throw Error('diagnostics failed');
    },
    valid: () => true,
    emit: () => {
      throw Error('sink failed');
    },
    secrets: () => [],
  });
  await expect(diagnosticSend({ tabId: 42 }, 'Page.enable')).resolves.toEqual({
    privateResult: 'VALUE',
  });
});
it('records explicit attachment, detachment and parent debugger reason', async () => {
  await diagnosticAttach({ tabId: 42 }, '1.3');
  await diagnosticDetach({ tabId: 42 });
  recordDebuggerEvent('detach', { tabId: 42 }, 'target_closed');
  expect(events.filter((value) => value.event.text.includes('"phase"'))).toHaveLength(4);
  expect(events.some((value) => value.event.text.includes('target_closed'))).toBe(true);
});
it('ignores debugger detach for a tab outside the task', () => {
  recordDebuggerEvent('detach', { tabId: 99 }, 'target_closed');
  expect(events).toHaveLength(0);
  expect(chrome.tabs.get).not.toHaveBeenCalled();
});
it('keeps a bounded summary instead of flooding capture with successful preview acknowledgements', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  await diagnosticSend({ tabId: 42 }, 'Runtime.evaluate');
  for (let i = 0; i < 2000; i++) await diagnosticSend({ tabId: 42 }, 'Page.screencastFrameAck');
  expect(events).toHaveLength(3);
  expect(events[0].event.text).toContain('Runtime.evaluate');
  expect(events[2].event.text).toContain('screencast-ack-summary');
  expect(events[2].event.text).toContain('"partial":true');
  await vi.advanceTimersByTimeAsync(5000);
  await diagnosticSend({ tabId: 42 }, 'Page.screencastFrameAck');
  expect(events).toHaveLength(4);
  expect(events[3].event.text).toContain('"successful":2001');
});
it('preserves slow and failed acknowledgements with native failure identity', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.mocked(chrome.debugger.sendCommand).mockImplementationOnce(async () => {
    vi.setSystemTime(100_300);
    return {};
  });
  await diagnosticSend({ tabId: 42 }, 'Page.screencastFrameAck');
  expect(events.some((item) => item.event.text.includes('slow-success'))).toBe(true);
  const error = new Error('Detached');
  vi.mocked(chrome.debugger.sendCommand).mockRejectedValueOnce(error);
  await expect(diagnosticSend({ tabId: 42 }, 'Page.screencastFrameAck')).rejects.toBe(error);
  expect(events.at(-1).event.text).toContain('"phase":"error"');
});
it('records parent target type from an explicitly timestamped prior query, without identity fields', async () => {
  (chrome.debugger.getTargets as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: 'SECRET_ID',
      tabId: 42,
      type: 'page',
      attached: true,
      title: 'SECRET_TITLE',
      url: 'https://secret.test/',
    },
  ]);
  await diagnosticAttach({ tabId: 42 }, '1.3');
  await new Promise((resolve) => setTimeout(resolve, 0));
  recordDebuggerEvent('detach', { tabId: 42 }, 'target_closed');
  const event = events.find((item) => item.event.text.includes('chrome.debugger.onDetach'));
  expect(event.event.text).toContain('"targetType":"page"');
  expect(event.event.text).toContain('earlier-getTargets');
  expect(event.event.text).toContain('targetTypeObservedAt');
  expect(JSON.stringify(events)).not.toContain('SECRET');
  expect(JSON.stringify(events)).not.toContain('secret.test');
});
it('uses iframe observation time for record windows and preserves receipt time separately', () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  refreshCdpDiagnostics();
  const emit = vi.mocked(startFrameDiagnostics).mock.calls.at(-1)![2];
  emit({ event: 'iframe-added', frame: 1, scheme: 'extension', observedAt: 90_000 });
  expect(events.at(-1).event.at).toBe(90_000);
  expect(events.at(-1).event.text).toContain('"receivedAt":100000');
  expect(events.at(-1).event.text).toContain('"observedAt":90000');
});
