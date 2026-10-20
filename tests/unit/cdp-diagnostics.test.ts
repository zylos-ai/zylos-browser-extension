// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
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
} from '../../utils/automation/cdp-diagnostics';
let token: string;
let task: number;
let events: any[];
beforeEach(() => {
  token = 'consent';
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
