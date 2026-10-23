// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const page = vi.hoisted(() => ({
  pinIncidentDocument: vi.fn(),
  captureIncidentPageState: vi.fn(),
}));
vi.mock('../../utils/automation/incident-page-state', () => page);
import { IncidentCapture } from '../../utils/incident-bundle';
const taskId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222:0';
const runtime = {
  connected: true,
  control: false,
  granted: false,
  scope: 'none' as const,
  groupReference: 'none' as const,
};
let scope: { consent: string; generation: number; navigation: number; tabId?: number };
let capture: IncidentCapture;
const snapshot = () =>
  ({ records: [{ at: Date.now(), sequence: 1, task: 1, operation: 2 }], dropped: 0 }) as any;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  scope = { consent: 'consent', generation: 1, navigation: 1, tabId: 7 };
  page.pinIncidentDocument.mockResolvedValue({ documentId: 'doc' });
  page.captureIncidentPageState.mockResolvedValue({
    status: 'captured',
    observedAt: Date.now(),
    state: { scheme: 'https' },
  });
  capture = new IncidentCapture(() => scope);
  capture.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('correlates exact protocol IDs and immutable action outcomes without arguments', async () => {
  const op = capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
  capture.trigger({ task: 1, operation: 2 }, 'debugger-detach', 'target_closed');
  capture.end(op, 'error');
  await vi.advanceTimersByTimeAsync(0);
  const result = capture.bundle(snapshot(), runtime);
  expect(result.correlations).toEqual([
    expect.objectContaining({ taskId, actionId: id, outcome: 'error' }),
  ]);
  expect(result.incidents[0]).toMatchObject({
    taskId,
    actionId: id,
    pageState: { status: 'captured' },
    recordSequences: [1],
  });
  expect(result.incidents[0]!.window.gaps).toContain('post-window-pending');
  expect(result.incidents[0]!.window.gaps).toContain('pre-window-not-captured');
  expect(result.incidents[0]!.window.complete).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(capture.bundle(snapshot(), runtime).incidents[0]!.window.gaps).not.toContain(
    'post-window-pending',
  );
  expect(result.incidents[0]!.window.gaps).toContain('post-window-pending');
});
it('deduplicates the terminal control loss and keeps failure facts separate', () => {
  capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
  capture.trigger({ task: 1, operation: 2 }, 'debugger-detach');
  capture.trigger({ task: 1 }, 'control-lost');
  expect(capture.bundle(snapshot(), runtime).incidents).toHaveLength(1);
});
it('freezes immediately and after the bounded post-window, but never after revocation or clear', async () => {
  const freeze = vi.fn();
  capture = new IncidentCapture(
    () => scope,
    () => runtime,
    freeze,
  );
  capture.trigger({}, 'control-lost');
  expect(freeze).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(freeze).toHaveBeenCalledTimes(2);
  capture.trigger({}, 'control-lost');
  scope.consent = '';
  await vi.advanceTimersByTimeAsync(2000);
  expect(freeze).toHaveBeenCalledTimes(3);
  capture.trigger({}, 'control-lost');
  expect(freeze).toHaveBeenCalledTimes(3);
  scope.consent = 'new';
  capture.trigger({}, 'control-lost');
  capture.clear();
  await vi.advanceTimersByTimeAsync(2000);
  expect(freeze).toHaveBeenCalledTimes(4);
});
it('does not collect while disabled or export untrusted correlation strings', () => {
  scope.consent = '';
  expect(capture.begin({}, taskId, id, 'fill')).toBeUndefined();
  capture.trigger({}, 'debugger-detach');
  expect(page.pinIncidentDocument).not.toHaveBeenCalled();
  scope.consent = 'new';
  capture.begin({ task: 1 }, 'PRIVATE_TITLE', 'https://private/', 'PRIVATE_METHOD');
  capture.trigger({ task: 1 }, 'control-lost');
  const result = capture.bundle(snapshot(), runtime);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(result.incidents[0]!.window.gaps).toContain('correlation-unavailable');
});
it('retains transport loss as a distinct fact without probing the disconnected page', () => {
  const freeze = vi.fn();
  capture = new IncidentCapture(
    () => scope,
    () => ({ ...runtime, connected: false }),
    freeze,
  );
  capture.trigger({}, 'control-lost');
  const incident = capture.bundle(snapshot(), runtime).incidents[0];
  expect(incident).toMatchObject({
    trigger: 'control-lost',
    runtimeAtTrigger: { connected: false },
    pageState: { status: 'unavailable' },
  });
  expect(page.captureIncidentPageState).not.toHaveBeenCalled();
  expect(freeze).toHaveBeenCalledOnce();
});
it('drops late page state after new task and clears all correlation on disable', async () => {
  let finish!: (result: any) => void;
  page.captureIncidentPageState.mockResolvedValueOnce({
    status: 'captured',
    observedAt: Date.now(),
    state: { scheme: 'https' },
  });
  page.captureIncidentPageState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  capture.begin({ task: 1 }, taskId, id, 'fill');
  capture.trigger({ task: 1 }, 'debugger-detach');
  await vi.advanceTimersByTimeAsync(0);
  scope.generation++;
  finish({ status: 'captured', observedAt: Date.now(), state: { private: true } });
  await vi.advanceTimersByTimeAsync(0);
  expect(capture.bundle(snapshot(), runtime).incidents[0]!.pageState.status).toBe('pending');
  capture.clear();
  const result = capture.bundle(snapshot(), runtime);
  expect(result.correlations).toHaveLength(0);
  expect(result.incidents).toHaveLength(0);
});
it('preserves trigger runtime separately from preview runtime and records ordinary errors', () => {
  const live = { ...runtime, control: true };
  capture = new IncidentCapture(
    () => scope,
    () => live,
  );
  capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
  capture.trigger({ task: 1, operation: 2 }, 'operation-error');
  live.control = false;
  const result = capture.bundle(snapshot(), live);
  expect(result.incidents[0]).toMatchObject({
    trigger: 'operation-error',
    runtimeAtTrigger: { control: true },
  });
  expect(result.previewRuntime.control).toBe(false);
  live.control = true;
  expect(result.previewRuntime.control).toBe(false);
});
it('does not deduplicate a different action in the same task', () => {
  capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
  capture.trigger({ task: 1, operation: 2 }, 'debugger-detach');
  capture.begin({ task: 1, operation: 3 }, taskId, `${id}:next`, 'snapshot');
  capture.trigger({ task: 1 }, 'control-lost');
  expect(capture.bundle(snapshot(), runtime).incidents).toHaveLength(2);
});
it('marks a delayed pre-state and never delays operation start', async () => {
  let finish!: (result: any) => void;
  page.captureIncidentPageState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(capture.begin({ task: 1 }, taskId, id, 'fill')).toBeDefined();
  await vi.advanceTimersByTimeAsync(0);
  capture.trigger({ task: 1 }, 'operation-error');
  await vi.advanceTimersByTimeAsync(10);
  finish({ status: 'captured', observedAt: Date.now(), state: { scheme: 'https' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(capture.bundle(snapshot(), runtime).incidents[0]!.window.gaps).toContain(
    'pre-state-not-before-trigger',
  );
});
it('does not propagate diagnostics failures into actions', () => {
  capture = new IncidentCapture(() => {
    throw new Error('scope unavailable');
  });
  expect(() => capture.begin({}, taskId, id, 'fill')).not.toThrow();
  expect(() => capture.end(undefined, 'completed')).not.toThrow();
  expect(() => capture.trigger({}, 'operation-error')).not.toThrow();
});
it('bounds incidents and mappings and reports truncation', () => {
  for (let i = 0; i < 260; i++) capture.begin({ task: i }, taskId, id, 'fill');
  for (let i = 0; i < 12; i++) capture.trigger({ task: i }, 'debugger-detach');
  const result = capture.bundle(snapshot(), runtime);
  expect(result.correlations).toHaveLength(256);
  expect(result.incidents).toHaveLength(8);
  expect(result.incidents[0]!.window.gaps).toContain('records-dropped');
});
it('reports when an incident outlives its correlation', () => {
  capture.begin({ task: 1 }, taskId, id, 'fill');
  capture.trigger({ task: 1 }, 'operation-error');
  for (let i = 0; i < 256; i++) capture.begin({ task: 2 }, taskId, `${id}:${i}`, 'fill');
  expect(capture.bundle(snapshot(), runtime).incidents[0]!.window.gaps).toContain(
    'correlation-evicted',
  );
});
it('does not read a newly navigated document for an old incident', async () => {
  let resolvePin!: (value: any) => void;
  page.pinIncidentDocument.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePin = resolve;
      }),
  );
  capture.begin({ task: 1 }, taskId, id, 'fill');
  capture.trigger({ task: 1 }, 'operation-error');
  scope.navigation++;
  resolvePin({ documentId: 'old-document' });
  await vi.advanceTimersByTimeAsync(0);
  expect(page.captureIncidentPageState).not.toHaveBeenCalled();
  expect(capture.bundle(snapshot(), runtime).incidents[0]!.pageState.status).toBe('stale');
});
it('merges exact-action error and detach facts, preserves runtime and avoids a second post probe', async () => {
  capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
  capture.trigger({ task: 1, operation: 2 }, 'operation-error');
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(10);
  capture.trigger({ task: 1, operation: 2 }, 'debugger-detach', 'target_closed');
  await vi.advanceTimersByTimeAsync(0);
  const result = capture.bundle(snapshot(), runtime);
  expect(result.incidents).toHaveLength(1);
  expect(result.incidents[0]!.trigger).toBe('debugger-detach');
  expect(result.incidents[0]!.triggerFacts.map((fact) => fact.trigger)).toEqual([
    'operation-error',
    'debugger-detach',
  ]);
  expect(result.incidents[0]!.window.gaps).toContain('page-state-before-trigger');
  expect(page.captureIncidentPageState).toHaveBeenCalledTimes(2); // One concurrent pre-state and one post-state.
});
it('merges an error following detach using its original action scope after invalidation', () => {
  const operation = capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
  capture.trigger({ task: 1, operation: 2 }, 'debugger-detach', 'target_closed');
  scope.navigation++;
  capture.end(operation, 'error');
  capture.trigger({ task: 1, operation: 2 }, 'operation-error');
  const result = capture.bundle(snapshot(), runtime);
  expect(result.incidents).toHaveLength(1);
  expect(result.incidents[0]!.triggerFacts).toHaveLength(2);
});
it('keeps the primary trigger identical to its retained fact after a repeated notification', async () => {
  capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
  capture.trigger({ task: 1, operation: 2 }, 'debugger-detach', 'target_closed');
  await vi.advanceTimersByTimeAsync(10);
  capture.trigger({ task: 1, operation: 2 }, 'debugger-detach', 'target_closed');
  const incident = capture.bundle(snapshot(), runtime).incidents[0]!;
  expect(incident.triggerFacts).toHaveLength(1);
  expect(incident.triggerFacts[0]!.triggeredAt).toBe(incident.triggeredAt);
});
it.each(['completed', 'error'] as const)(
  'does not attribute a between-action detach to the previous %s action',
  (outcome) => {
    const operation = capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
    capture.end(operation, outcome);
    capture.trigger({ task: 1 }, 'debugger-detach');
    expect(capture.bundle(snapshot(), runtime).incidents[0]!.actionId).toBeUndefined();
  },
);
it('does not use an orphaned running correlation when no operation is active', () => {
  capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
  capture.trigger({ task: 1 }, 'debugger-detach');
  expect(capture.bundle(snapshot(), runtime).incidents[0]!.actionId).toBeUndefined();
});
it('does not merge reused wire IDs across a new action scope', () => {
  capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
  capture.trigger({ task: 1, operation: 2 }, 'operation-error');
  scope.navigation++;
  capture.begin({ task: 1, operation: 3 }, taskId, id, 'fill');
  capture.trigger({ task: 1, operation: 3 }, 'debugger-detach');
  expect(capture.bundle(snapshot(), runtime).incidents).toHaveLength(2);
});
it('retains detach incidents under ordinary-error pressure and reports loss', () => {
  for (let i = 0; i < 8; i++) {
    capture.begin({ task: 1, operation: i }, taskId, `${id}:${i}`, 'fill');
    capture.trigger({ task: 1, operation: i }, 'debugger-detach');
  }
  for (let i = 8; i < 30; i++) {
    capture.begin({ task: 1, operation: i }, taskId, `${id}:${i}`, 'fill');
    capture.trigger({ task: 1, operation: i }, 'operation-error');
  }
  const result = capture.bundle(snapshot(), runtime);
  expect(result.incidents).toHaveLength(8);
  expect(result.incidents.every((item) => item.trigger === 'debugger-detach')).toBe(true);
  expect(result.incidents[0]!.window.gaps).toContain('incidents-evicted');
});
it.each([0, 10])(
  'marks pre-state observed %i milliseconds after action start even before the trigger',
  async (delay) => {
    page.captureIncidentPageState.mockResolvedValue({
      status: 'captured',
      observedAt: Date.now() + delay,
      state: { scheme: 'https' },
    });
    capture.begin({ task: 1, operation: 2 }, taskId, id, 'fill');
    await vi.advanceTimersByTimeAsync(20);
    capture.trigger({ task: 1, operation: 2 }, 'operation-error');
    await vi.advanceTimersByTimeAsync(0);
    const incident = capture.bundle(snapshot(), runtime).incidents[0]!;
    expect(incident.pageBeforeTiming.relation).toBe(
      delay ? 'after-action-start' : 'same-millisecond',
    );
    expect(incident.window.gaps).toContain(
      delay ? 'pre-state-after-action-start' : 'pre-state-order-unresolved',
    );
    expect(incident.window.gaps).not.toContain('pre-state-not-before-trigger');
  },
);
