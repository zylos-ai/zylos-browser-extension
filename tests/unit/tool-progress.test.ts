import { expect, test } from 'vitest';
import { summarizeTools } from '../../utils/tool-progress';
import type { ToolRun, ToolStep } from '../../utils/remote';
const step = (method: string, number: number, more: Partial<ToolStep> = {}): ToolStep => ({
  id: `s${number}`,
  number,
  method,
  status: 'success',
  queuedAt: number * 10,
  startedAt: number * 10,
  endedAt: number * 10 + 5,
  ...more,
});
const run = (steps: ToolStep[], more: Partial<ToolRun> = {}): ToolRun => ({
  status: 'running',
  startedAt: 0,
  total: steps.length,
  failed: steps.filter((s) => s.status === 'error').length,
  steps,
  ...more,
});

test('groups page work without surfacing setup, refs, tiny waits, or cleanup', () => {
  const methods = [
    'info',
    'describe',
    'open',
    'snapshot',
    'find',
    'inspect',
    'click',
    'snapshot',
    'find',
    'fill',
    'type',
    'keypress',
    'wait',
    'frames',
    'tabs',
    'finish',
    'finalize',
  ];
  const r = run(
    methods.map((m, i) =>
      step(m, i, { target: m === 'open' ? 'https://example.com/' : '@private-ref' }),
    ),
  );
  const original = JSON.stringify(r);
  const result = summarizeTools(r, 10000);
  expect(result.stages.map((s) => s.kind)).toEqual(['opening', 'reading', 'operating']);
  expect(result.stages[2]!.steps.map((s) => s.method)).toEqual([
    'click',
    'snapshot',
    'find',
    'fill',
    'type',
    'keypress',
  ]);
  expect(result.stages.map((s) => s.target)).toEqual([
    'https://example.com/',
    undefined,
    undefined,
  ]);
  expect(result.label).toBe('activityWaiting');
  expect(JSON.stringify(r)).toBe(original);
});

test('navigation stays chronological, and changing tabs separates operations', () => {
  const result = summarizeTools(
    run(
      ['open', 'click', 'switch-tab', 'snapshot', 'scroll', 'back', 'snapshot'].map((m, i) =>
        step(m, i),
      ),
    ),
  );
  expect(result.stages.map((s) => s.kind)).toEqual([
    'opening',
    'operating',
    'switching',
    'reading',
    'operating',
    'back',
    'reading',
  ]);
});

test('a live wait crosses the threshold without being a step during a short pause', () => {
  const r = run([
    step('click', 1),
    step('wait', 2, { status: 'running', startedAt: 1000, endedAt: undefined }),
  ]);
  expect(summarizeTools(r, 2999).stages).toHaveLength(1);
  expect(summarizeTools(r, 2999).label).toBe('activityOperating');
  expect(summarizeTools(r, 3000).stages.map((s) => s.kind)).toEqual(['operating', 'waiting']);
  expect(summarizeTools(r, 3000).label).toBe('activityWaitingPage');
});

test('hidden-tool errors and brief failed waits remain visible while proven recoveries do not warn', () => {
  const r = run([step('describe', 1, { status: 'error' }), step('wait', 2, { status: 'error' })], {
    status: 'completed',
  });
  expect(summarizeTools(r).stages.map((s) => s.kind)).toEqual(['preparing', 'waiting']);
  expect(summarizeTools(r).label).toBe('activityNeedsAttention');
  r.steps.forEach((s) => {
    s.recovered = true;
  });
  r.recovered = 2;
  expect(summarizeTools(r).hasIssues).toBe(false);
  expect(summarizeTools(r).label).toBe('activityCompleted');
});

test('unrelated successes, omitted failures and unconfirmed in-flight work cannot become a clean success', () => {
  expect(
    summarizeTools(
      run([step('click', 1, { status: 'error' }), step('snapshot', 2)], { status: 'completed' }),
    ).hasIssues,
  ).toBe(true);
  expect(
    summarizeTools(
      run([step('snapshot', 5)], { status: 'completed', failed: 3, recovered: 2, total: 5 }),
    ).omittedErrors,
  ).toBe(1);
  expect(
    summarizeTools(run([step('click', 1, { status: 'interrupted' })], { status: 'completed' }))
      .hasIssues,
  ).toBe(true);
});

test('idle, queued, stopped and preparation states reflect observed activity, never invented thinking', () => {
  expect(summarizeTools(run([step('info', 1, { status: 'running' })])).label).toBe(
    'activityPreparing',
  );
  expect(summarizeTools(run([step('click', 1, { status: 'queued' })])).label).toBe(
    'activityQueued',
  );
  expect(summarizeTools(run([step('snapshot', 1)])).label).toBe('activityWaiting');
  expect(
    summarizeTools(run([step('click', 1, { status: 'cancelled' })], { status: 'stopped' })).label,
  ).toBe('activityStopped');
  expect(summarizeTools(run([step('click', 1, { replayed: true })])).stages).toHaveLength(0);
});
