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
    'tabs',
    'frames',
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
  expect(result.stages.map((s) => s.kind)).toEqual([
    'opening',
    'reading',
    'locating',
    'inspecting',
    'operating',
    'locating',
    'typing',
    'keyboard',
  ]);
  expect(result.stages[4]!.steps.map((s) => s.method)).toEqual(['click', 'snapshot']);
  expect(result.stages[6]!.steps.map((s) => s.method)).toEqual(['fill', 'type']);
  expect(result.stages.flatMap((s) => (s.target ? [s.target] : []))).toEqual([
    'https://example.com/',
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
    'scrolling',
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
  const r = run([step('frames', 1, { status: 'error' }), step('wait', 2, { status: 'error' })], {
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
  expect(summarizeTools(run([step('tabs', 1, { status: 'running' })])).label).toBe(
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

test('execution requires a real tool start or response, including hidden preparation tools', () => {
  const r = run([]);
  expect(summarizeTools(r, 300_000).hasExecution).toBe(false);
  expect(summarizeTools(r, 300_000).phaseLabel).toBe('progressAwaiting');
  r.steps.push(step('describe', 1, { status: 'queued', startedAt: undefined, endedAt: undefined }));
  expect(summarizeTools(r).hasExecution).toBe(false);
  r.steps[0]!.status = 'running';
  expect(summarizeTools(r).hasExecution).toBe(true);
  r.steps[0]!.status = 'success';
  expect(summarizeTools(r).hasExecution).toBe(true);
  expect(summarizeTools(r).phaseLabel).toBe('progressWorking');
  r.steps[0]!.replayed = true;
  expect(summarizeTools(r).hasExecution).toBe(false);
  expect(summarizeTools(r).phaseLabel).toBe('progressAwaiting');
  r.steps[0]!.replayed = false;
  r.steps[0]!.status = 'cancelled';
  expect(summarizeTools(r).hasExecution).toBe(false);
  r.steps[0]!.startedAt = 20;
  expect(summarizeTools(r).hasExecution).toBe(true);
});

test('consecutive scroll observations merge but new phase descriptions and later revisits remain', () => {
  const r = run([
    step('scroll', 1, { summary: '继续查看后面的应用' }),
    step('snapshot', 2),
    step('tabs', 3),
    step('scroll', 4),
    step('snapshot', 5),
    step('find', 6),
    step('scroll', 7, { summary: '查看下一组下载量' }),
    step('snapshot', 8),
  ]);
  const result = summarizeTools(r);
  expect(result.stages.map((s) => s.kind)).toEqual(['scrolling', 'locating', 'scrolling']);
  expect(result.stages.map((s) => s.summary)).toEqual([
    '继续查看后面的应用',
    undefined,
    '查看下一组下载量',
  ]);
  expect(result.phaseLabel).toBe('progressReviewScroll');
  r.steps.push(step('record-findings', 9, { status: 'running', endedAt: undefined }));
  expect(summarizeTools(r).phaseLabel).toBe('progressRecording');
});
