// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserLoop, type AgentRequest } from '../../utils/browser-loop';
import { ControlLoss } from '../../utils/control-loss';
import * as diagnostics from '../../utils/diagnostics';

afterEach(() => vi.unstubAllGlobals());
it('retains research prefixes and records research success/failure without private content', async () => {
  const local: Record<string, unknown> = {},
    session: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: 'test' }) },
    storage: {
      local: { get: async () => local, set: async (x: object) => Object.assign(local, x) },
      session: {
        get: async () => session,
        set: async (x: object) => Object.assign(session, structuredClone(x)),
      },
    },
  });
  await diagnostics.initializeDiagnostics();
  await diagnostics.setDiagnosticsEnabled(true);
  diagnostics.startDiagnosticTask();
  const requests: AgentRequest[] = [];
  const finish = vi.fn(async () => {});
  const execute = vi.fn(async () => ({
    mode: 'operating' as const,
    observation: {},
    results: [],
    failed: false,
  }));
  const record = vi.fn();
  const loop = new BrowserLoop({
    send: (r) => {
      requests.push(r);
      return true;
    },
    input: () => true,
    execute,
    record,
    finish,
    cancel: () => {},
  });
  loop.start(
    'task',
    { role: 'user', content: [{ type: 'text', text: 'goal' }] },
    { type: 'current-page', status: 'unavailable' },
  );
  loop.accept(requests[0]!.id, {
    kind: 'actions',
    actions: [{ method: 'open', params: { url: 'https://example.com' } }],
  });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  const notes = (targetCount: number) => ({
    method: 'record-findings',
    params: { collection: 'PRIVATE_NOTES', targetCount, items: [] },
  });
  loop.accept(requests[1]!.id, { kind: 'actions', actions: [notes(1)] });
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  loop.accept(requests[2]!.id, { kind: 'actions', actions: [notes(2)] });
  await vi.waitFor(() => expect(requests).toHaveLength(4));
  execute.mockRejectedValueOnce(
    new ControlLoss({
      reason: 'CONTROL_LOST',
      results: [{ method: 'fill', outcome: 'completed' }],
      observation: 'unavailable',
      resume: 'new-user-message-required',
    }),
  );
  loop.accept(requests[3]!.id, {
    kind: 'actions',
    actions: [notes(1), { method: 'fill', params: { ref: '@field', text: 'PRIVATE_INPUT' } }],
  });
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
  expect((finish.mock.calls[0] as unknown[])[4]).toMatchObject({
    results: [
      { method: 'record-findings', outcome: 'completed' },
      { method: 'fill', outcome: 'completed' },
    ],
  });
  const capture = await diagnostics.getDiagnostics({});
  expect(capture.events.filter((e) => e.event === 'operation-start')).toHaveLength(3);
  expect(capture.events.filter((e) => e.event === 'operation-result')).toHaveLength(2);
  expect(capture.events.filter((e) => e.event === 'operation-error')).toHaveLength(1);
  expect(JSON.stringify(capture)).not.toContain('PRIVATE');
  await diagnostics.setDiagnosticsEnabled(false);
});
