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
  expect(await d.getDiagnostics({})).toEqual({
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
  ])
    await expect(d.getDiagnostics(params)).rejects.toThrow();
});

it('bounds records, paginates, expires, and survives worker restart', async () => {
  vi.useFakeTimers();
  let d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  await d.setDiagnosticsEnabled(true);
  for (let i = 0; i < 250; i++) d.recordDiagnostic('detach', 'target_closed');
  const page = await d.getDiagnostics({ limit: 100 });
  expect(page.events).toHaveLength(100);
  expect(page.dropped).toBe(51);
  expect(page.events[0]!.seq).toBe(52);
  expect((await d.getDiagnostics({ after: page.nextCursor, limit: 200 })).events).toHaveLength(100);
  vi.resetModules();
  d = await import('../../utils/diagnostics');
  await d.initializeDiagnostics();
  expect((await d.getDiagnostics({ limit: 200 })).events).toHaveLength(200);
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
  expect(writes).toBe(2);
  expect(JSON.stringify(session)).not.toContain('target_closed');
  expect((await d.getDiagnostics({})).enabled).toBe(false);
});
