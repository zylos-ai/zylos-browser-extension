// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

let local: Record<string, unknown>;
let session: Record<string, unknown>;
beforeEach(() => {
  vi.resetModules();
  local = {};
  session = {};
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '9.8.7' }) },
    storage: {
      local: {
        get: async () => local,
        set: async (v: object) => {
          Object.assign(local, v);
        },
      },
      session: {
        get: async () => session,
        set: async (v: object) => {
          Object.assign(session, structuredClone(v));
        },
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('defaults off and rejects parameters that could change consent', async () => {
  const d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  d.recordDiagnostic('detach', 'target_closed');
  expect(await d.getDiagnostics({})).toMatchObject({
    enabled: false,
    version: '9.8.7',
    events: [],
    nextCursor: 0,
    dropped: 0,
  });
  for (const params of [
    { enabled: true },
    { limit: 201 },
    { limit: 0 },
    { after: -1 },
    { after: 0.5 },
    { after: 1 },
    { through: 1 },
    { after: 2, through: 1 },
  ])
    await expect(d.getDiagnostics(params)).rejects.toThrow();
});

it('bounds records, paginates, expires, and survives worker restart', async () => {
  vi.useFakeTimers();
  let d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  await d.setDiagnosticsEnabled(true);
  for (let i = 0; i < 1250; i++) d.recordDiagnostic('detach', 'target_closed');
  const page = await d.getDiagnostics({ limit: 100 });
  expect(page.events).toHaveLength(100);
  expect(page.dropped).toBe(251);
  expect(page.events[0]!.seq).toBe(252);
  expect(page.truncated).toBe(true);
  expect(page.hasMore).toBe(true);
  expect((await d.getDiagnostics({ after: page.nextCursor, limit: 200 })).events).toHaveLength(200);
  vi.resetModules();
  d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  expect((await d.getDiagnostics({ limit: 200 })).events).toHaveLength(200);
  expect((await d.getDiagnostics({})).restartCount).toBe(1);
  expect((await d.getDiagnostics({})).epoch).toBe(page.epoch);
  vi.advanceTimersByTime(d.TTL + 1);
  expect((await d.getDiagnostics({})).events).toEqual([]);
});

it('drops untrusted strings and disabling clears queued and persisted records', async () => {
  const d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  await d.setDiagnosticsEnabled(true);
  d.recordDiagnostic('detach', 'https://secret.invalid?token=secret' as any);
  d.recordDiagnostic('stopped', 'grant_changed');
  expect(JSON.stringify(await d.getDiagnostics({}))).not.toContain('secret');
  const disabling = d.setDiagnosticsEnabled(false);
  d.recordDiagnostic('detach', 'target_closed');
  await disabling;
  expect((await d.getDiagnostics({})).events).toEqual([]);
  expect(JSON.stringify(session)).not.toContain('grant_changed');
  vi.resetModules();
  const restarted = await import('../../utils/diagnostics');
  await restarted.initializeDiagnostics();
  expect((await restarted.getDiagnostics({})).enabled).toBe(false);
});

it('coalesces slow writes and flushes a disable after an in-flight snapshot', async () => {
  const d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  await d.setDiagnosticsEnabled(true);
  let finish!: () => void;
  let writes = 0;
  chrome.storage.session.set = vi.fn(async (value: object) => {
    writes++;
    const snapshot = structuredClone(value);
    if (writes === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    Object.assign(session, snapshot);
  });
  for (let i = 0; i < 1000; i++) d.recordDiagnostic('detach', 'target_closed');
  expect(writes).toBe(1);
  const disabling = d.setDiagnosticsEnabled(false);
  await Promise.resolve();
  finish();
  await disabling;
  expect(writes).toBeGreaterThanOrEqual(2);
  expect(writes).toBeLessThanOrEqual(3);
  expect(JSON.stringify(session)).not.toContain('target_closed');
  expect((await d.getDiagnostics({})).enabled).toBe(false);
});

it('filters a frozen snapshot and exposes epoch resets and stale panel or operation captures', async () => {
  const d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  await d.setDiagnosticsEnabled(true);
  const consent = d.diagnosticsConsent();
  const task = d.startDiagnosticTask();
  const operation = d.startDiagnosticOperation('fill');
  d.recordDiagnostic('detach', 'target_closed', { source: 'executor', level: 'warn' });
  d.endDiagnosticOperation(
    operation,
    Object.assign(new Error('PRIVATE_ERROR'), { code: 'STOPPED' }),
  );
  d.endDiagnosticTask('interrupted', true);
  expect(d.acceptPanelDiagnostic(consent, { event: 'console', level: 'warn', argCount: 2 })).toBe(
    true,
  );
  const first = await d.getDiagnostics({ task, limit: 2 });
  expect(first.events.map((e) => e.event)).toEqual(['task-start', 'operation-start']);
  d.recordLifecycle('console', { level: 'info' });
  const next = await d.getDiagnostics({
    task,
    after: first.nextCursor,
    through: first.highWater,
    epoch: first.epoch,
  });
  expect(next.events.map((e) => e.event)).toEqual(['detach', 'operation-error', 'task-cancel']);
  expect(next.events[1]).toMatchObject({ task, op: operation.op, method: 'fill', code: 'STOPPED' });
  expect(next.highWater).toBe(first.highWater);
  expect(next.hasMore).toBe(false);
  expect(JSON.stringify(next)).not.toContain('PRIVATE_ERROR');
  expect((await d.getDiagnostics({ source: 'executor' })).events).toHaveLength(1);
  await d.setDiagnosticsEnabled(false);
  await d.setDiagnosticsEnabled(true);
  expect(d.acceptPanelDiagnostic(consent, { event: 'console', level: 'error' })).toBe(false);
  d.endDiagnosticOperation(operation, new Error('stale'));
  expect((await d.getDiagnostics({})).events.map((e) => e.event)).toEqual(['enabled']);
  await expect(d.getDiagnostics({ epoch: first.epoch })).rejects.toMatchObject({
    code: 'DIAGNOSTICS_RESET',
  });
});

it('reports panel loss and storage failures without exposing arbitrary error properties', async () => {
  const d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  await d.setDiagnosticsEnabled(true);
  expect(
    d.acceptPanelDiagnostic(d.diagnosticsConsent(), {
      event: 'capture-overflow',
      level: 'warn',
      count: 7,
    }),
  ).toBe(true);
  const failure = Object.assign(new TypeError('PRIVATE_STORAGE'), {
    code: 'PRIVATE_CODE',
    nested: { secret: 'PRIVATE_NESTED' },
  });
  await expect(
    d.diagnosticStorage('write', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  const result = await d.getDiagnostics({});
  expect(result.dropped).toBe(7);
  expect(result.events.at(-1)).toMatchObject({
    event: 'storage-error',
    errorKind: 'TypeError',
    code: 'STORAGE_WRITE_FAILED',
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  const original = chrome.storage.session.set;
  chrome.storage.session.set = vi.fn(async () => {
    throw failure;
  });
  d.recordLifecycle('console');
  const unhealthy = await d.getDiagnostics({});
  expect(unhealthy.storageHealthy).toBe(false);
  chrome.storage.session.set = original;
});

it('serializes concurrent consent writes so a delayed enable cannot undo a disable', async () => {
  const d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  let finish!: () => void;
  chrome.storage.local.set = vi.fn(async (value: Record<string, unknown>) => {
    if (value[d.DIAGNOSTICS_ENABLED_KEY] === true)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    Object.assign(local, value);
  });
  const enabling = d.setDiagnosticsEnabled(true);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const disabling = d.setDiagnosticsEnabled(false);
  expect(d.diagnosticsEnabled()).toBe(false);
  finish();
  await Promise.all([enabling, disabling]);
  expect(local[d.DIAGNOSTICS_ENABLED_KEY]).toBe(false);
  expect((await d.getDiagnostics({})).events).toEqual([]);
});

it('marks a corrupt or older persisted ring as incomplete rather than a fresh capture', async () => {
  local['remote-diagnostics-enabled'] = true;
  session['remote-diagnostics-session'] = { events: ['PRIVATE_CORRUPTION'] };
  const d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  const result = await d.getDiagnostics({});
  expect(result.storageHealthy).toBe(false);
  expect(result.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: 'storage-error', code: 'STORAGE_READ_FAILED' }),
    ]),
  );
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
