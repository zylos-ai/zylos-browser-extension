import type { TranslationKey } from './i18n';
import type { ToolRun, ToolStep } from './remote';

export const LONG_WAIT_MS = 2000;
const hidden = new Set([
  'info',
  'describe',
  'tabs',
  'frames',
  'pause',
  'finish',
  'stop',
  'finalize',
]);
const reads = new Set([
  'read-page',
  'snapshot',
  'observe',
  'screenshot',
  'find',
  'inspect',
  'record-findings',
  'read-findings',
]);
const activities = {
  find: 'locating',
  inspect: 'inspecting',
  fill: 'typing',
  type: 'typing',
  select: 'selecting',
  check: 'selecting',
  scroll: 'scrolling',
  hover: 'hovering',
  drag: 'dragging',
  keypress: 'keyboard',
  dialog: 'dialog',
  'record-findings': 'recording',
  'read-findings': 'organizing',
} as const;
const verificationReads = new Set<ProgressKind>([
  'operating',
  'locating',
  'inspecting',
  'typing',
  'selecting',
  'scrolling',
  'hovering',
  'dragging',
  'keyboard',
  'dialog',
]);
const navigation = {
  open: 'opening',
  'new-tab': 'opening',
  'switch-tab': 'switching',
  'use-current-tab': 'current',
  back: 'back',
  forward: 'forward',
  reload: 'reload',
} as const;
export type ProgressKind =
  | 'reading'
  | 'operating'
  | 'waiting'
  | 'preparing'
  | (typeof navigation)[keyof typeof navigation]
  | (typeof activities)[keyof typeof activities];
export type ProgressStage = {
  id: string;
  kind: ProgressKind;
  status: ToolStep['status'];
  steps: ToolStep[];
  target?: string;
  summary?: string;
};
export const stageLabels: Record<ProgressKind, TranslationKey> = {
  locating: 'stageLocating',
  inspecting: 'stageInspecting',
  typing: 'stageTyping',
  selecting: 'stageSelecting',
  scrolling: 'stageScrolling',
  hovering: 'stageHovering',
  dragging: 'stageDragging',
  keyboard: 'stageKeyboard',
  dialog: 'stageDialog',
  recording: 'stageRecording',
  organizing: 'stageOrganizing',
  preparing: 'stagePreparing',
  reading: 'stageReading',
  operating: 'stageOperating',
  waiting: 'stageWaiting',
  opening: 'stageOpening',
  switching: 'stageSwitching',
  current: 'stageCurrent',
  back: 'toolBack',
  forward: 'toolForward',
  reload: 'toolReload',
};
const activeLabels: Record<ProgressKind, TranslationKey> = {
  locating: 'progressLocating',
  inspecting: 'progressInspecting',
  typing: 'progressTyping',
  selecting: 'progressSelecting',
  scrolling: 'progressScrolling',
  hovering: 'progressHovering',
  dragging: 'progressDragging',
  keyboard: 'progressKeyboard',
  dialog: 'progressDialog',
  recording: 'progressRecording',
  organizing: 'progressOrganizing',
  preparing: 'activityPreparing',
  reading: 'activityReading',
  operating: 'activityOperating',
  waiting: 'activityWaitingPage',
  opening: 'activityOpening',
  switching: 'activitySwitching',
  current: 'activityCurrent',
  back: 'activityNavigating',
  forward: 'activityNavigating',
  reload: 'activityReloading',
};
const unresolved = (s: ToolStep) => s.status === 'error' && !s.recovered && !s.replayed;
function kind(step: ToolStep): ProgressKind {
  if (Object.hasOwn(navigation, step.method))
    return navigation[step.method as keyof typeof navigation];
  if (Object.hasOwn(activities, step.method))
    return activities[step.method as keyof typeof activities];
  if (reads.has(step.method)) return 'reading';
  if (['wait', 'wait-for-page'].includes(step.method)) return 'waiting';
  return hidden.has(step.method) ? 'preparing' : 'operating';
}
function status(steps: ToolStep[]): ToolStep['status'] {
  if (steps.some((s) => s.status === 'running')) return 'running';
  if (steps.some((s) => s.status === 'queued')) return 'queued';
  if (steps.some(unresolved)) return 'error';
  if (steps.some((s) => s.status === 'interrupted')) return 'interrupted';
  if (steps.some((s) => s.status === 'cancelled')) return 'cancelled';
  return 'success';
}

/** A display projection only: raw events and their original errors remain unchanged. */
export function summarizeTools(run: ToolRun, now = Date.now()) {
  const stages: ProgressStage[] = [];
  for (const step of run.steps) {
    if (step.replayed) continue;
    if (hidden.has(step.method) && !unresolved(step) && step.status !== 'interrupted') continue;
    const elapsed = (step.endedAt ?? now) - (step.startedAt ?? step.queuedAt);
    const shortWait =
      ['wait', 'wait-for-page'].includes(step.method) &&
      (step.status === 'queued' || elapsed < LONG_WAIT_MS) &&
      !unresolved(step) &&
      step.status !== 'interrupted';
    // Tiny waits are part of the surrounding action; they do not add a numbered stage.
    if (shortWait) continue;
    const nextKind = kind(step);
    const previous = stages.at(-1);
    const isNavigation = Object.hasOwn(navigation, step.method);
    // Fold automatic verification reads into their action. Different activities
    // and explicit Agent phase descriptions keep their place in the timeline.
    if (
      previous &&
      !isNavigation &&
      (!step.summary || step.summary === previous.summary) &&
      (previous.kind === nextKind ||
        (verificationReads.has(previous.kind) && nextKind === 'reading'))
    ) {
      previous.steps.push(step);
    } else {
      stages.push({
        id: step.id,
        kind: nextKind,
        status: step.status,
        steps: [step],
        summary: step.summary,
        // Refs, coordinates and numeric tab IDs belong only in the diagnostic log.
        target: isNavigation && /^https?:\/\//.test(step.target ?? '') ? step.target : undefined,
      });
    }
  }
  for (const stage of stages) stage.status = status(stage.steps);
  const retainedErrors = run.steps.filter(unresolved).length;
  const recovered = run.recovered ?? run.steps.filter((s) => s.recovered).length;
  const omittedErrors = Math.max(0, run.failed - recovered - retainedErrors);
  const issueStages = stages.filter(
    (s) => s.steps.some(unresolved) || s.status === 'interrupted',
  ).length;
  const hasIssues = issueStages > 0 || omittedErrors > 0;
  const running = [...run.steps].reverse().find((s) => s.status === 'running');
  const queued = run.steps.some((s) => s.status === 'queued');
  // A queued request or a timer is not evidence that execution has started.
  const hasExecution = run.steps.some(
    (s) =>
      !s.replayed &&
      (s.status === 'running' ||
        s.status === 'success' ||
        s.status === 'error' ||
        (s.status !== 'queued' && s.startedAt !== undefined)),
  );
  let label: TranslationKey;
  if (run.status === 'stopped') label = 'activityStopped';
  else if (run.status === 'interrupted') label = 'activityInterrupted';
  else if (run.status === 'completed')
    label = hasIssues ? 'activityNeedsAttention' : 'activityCompleted';
  else if (running) {
    if (['finish', 'finalize'].includes(running.method)) label = 'activityFinishing';
    else if (['stop', 'pause'].includes(running.method)) label = 'activityStopping';
    else if (
      ['wait', 'wait-for-page'].includes(running.method) &&
      now - (running.startedAt ?? running.queuedAt) < LONG_WAIT_MS
    ) {
      label = activeLabels[stages.at(-1)?.kind ?? 'preparing'];
    } else label = activeLabels[kind(running)];
  } else if (queued) label = 'activityQueued';
  else if (run.steps.at(-1)?.method === 'pause' && run.steps.at(-1)?.status === 'success')
    label = 'activityPaused';
  else label = 'activityWaiting';
  return {
    stages,
    label,
    hasIssues,
    issueStages,
    omittedErrors,
    hasExecution,
    busy: run.status === 'running' && (!!running || queued),
    phaseLabel: running
      ? label
      : queued
        ? 'activityQueued'
        : idleLabel(stages.at(-1)?.kind, hasExecution),
  };
}

function idleLabel(last: ProgressKind | undefined, hasExecution: boolean): TranslationKey {
  if (!hasExecution) return 'progressAwaiting';
  if (!last || last === 'preparing') return 'progressWorking';
  if (last === 'recording' || last === 'organizing') return 'progressReviewFindings';
  if (last === 'scrolling') return 'progressReviewScroll';
  if (last === 'locating' || last === 'inspecting') return 'progressPlanning';
  if (verificationReads.has(last)) return 'progressChecking';
  return 'progressAnalyzing';
}
