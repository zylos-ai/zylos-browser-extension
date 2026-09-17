import { useId, useState } from 'react';
import type { TranslationKey } from '../utils/i18n';
import type { ToolRun, ToolStep } from '../utils/remote';
import type { RemoteMethod } from '../utils/tool-catalog';
import { useI18n } from './LanguageProvider';

const labels = {
  info: 'toolInfo',
  describe: 'toolDescribe',
  'use-current-tab': 'toolUseCurrentTab',
  start: 'toolStart',
  open: 'toolOpen',
  'new-tab': 'toolNewTab',
  'switch-tab': 'toolSwitchTab',
  tabs: 'toolTabs',
  frames: 'toolFrames',
  snapshot: 'toolSnapshot',
  observe: 'toolObserve',
  screenshot: 'toolScreenshot',
  find: 'toolFind',
  inspect: 'toolInspect',
  click: 'toolClick',
  hover: 'toolHover',
  'double-click': 'toolDoubleClick',
  'right-click': 'toolRightClick',
  drag: 'toolDrag',
  fill: 'toolFill',
  type: 'toolType',
  select: 'toolSelect',
  check: 'toolCheck',
  scroll: 'toolScroll',
  keypress: 'toolKeypress',
  back: 'toolBack',
  forward: 'toolForward',
  reload: 'toolReload',
  dialog: 'toolDialog',
  wait: 'toolWait',
  pause: 'toolPause',
  finish: 'toolFinish',
  stop: 'toolStop',
  finalize: 'toolFinalize',
} satisfies Record<RemoteMethod, TranslationKey>;
const statuses: Record<ToolStep['status'], TranslationKey> = {
  queued: 'stepQueued',
  running: 'stepRunning',
  success: 'stepSuccess',
  error: 'stepError',
  cancelled: 'stepCancelled',
  interrupted: 'stepInterrupted',
};

function duration(ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

export function ToolSteps({ run }: { run: ToolRun }) {
  const { t } = useI18n();
  const listId = useId();
  // A phase change resets the default, while an explicit toggle remains local
  // to that phase. Final replies collapse even a previously expanded live run.
  const [toggle, setToggle] = useState<{ phase: ToolRun['status']; open: boolean }>();
  const open = toggle?.phase === run.status ? toggle.open : run.status === 'running';
  const busy = run.steps.some((step) => step.status === 'running' || step.status === 'queued');
  const phase =
    run.status === 'running'
      ? busy
        ? 'activityRunning'
        : 'activityWaiting'
      : run.status === 'completed'
        ? 'activityCompleted'
        : run.status === 'stopped'
          ? 'activityStopped'
          : 'activityInterrupted';
  return (
    <section className="tool-activity" data-status={run.status} aria-label={t('activityTitle')}>
      <button
        type="button"
        className="tool-activity-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setToggle({ phase: run.status, open: !open })}
      >
        <span
          className={`tool-activity-icon ${busy && run.status === 'running' ? 'is-busy' : ''}`}
          aria-hidden="true"
        >
          ≡
        </span>
        <span className="tool-activity-heading">
          <span className="tool-activity-title">
            {t('activityTitle')}{' '}
            <span className="tool-activity-count">{t('activityCount', { count: run.total })}</span>
          </span>
          <span className="tool-activity-summary">
            {t(phase)}
            {run.endedAt !== undefined && ` · ${duration(run.endedAt - run.startedAt)}`}
            {run.failed > 0 && (
              <span className="tool-activity-failures">
                {' '}
                · {t('activityFailures', { count: run.failed })}
              </span>
            )}
          </span>
        </span>
        <span className="tool-activity-chevron" aria-hidden="true">
          {open ? '⌃' : '⌄'}
        </span>
      </button>
      <div id={listId} hidden={!open} className="tool-activity-body">
        {run.total > run.steps.length && (
          <p className="tool-activity-note">
            {t('activityOmitted', {
              count: run.steps.length,
              omitted: run.total - run.steps.length,
            })}
          </p>
        )}
        <ol className="tool-step-list" aria-label={t('activityTitle')}>
          {run.steps.map((step) => (
            <li key={step.id} className="tool-step" data-status={step.status}>
              <span className="tool-step-marker" aria-hidden="true">
                {step.status === 'success' ? '✓' : step.status === 'error' ? '!' : step.number}
              </span>
              <div className="tool-step-content">
                <div className="tool-step-heading">
                  <span className="tool-step-label">
                    {Object.hasOwn(labels, step.method)
                      ? t(labels[step.method as RemoteMethod])
                      : step.method}
                  </span>
                  <span className="tool-step-status">{t(statuses[step.status])}</span>
                </div>
                <p className="tool-step-detail">
                  <code>{step.method}</code>
                  {step.endedAt !== undefined &&
                    ` · ${duration(step.endedAt - (step.startedAt ?? step.queuedAt))}`}
                  {step.replayed && ` · ${t('stepReplayed')}`}
                </p>
                {step.target && (
                  <p className="tool-step-target" title={step.target}>
                    {step.target}
                  </p>
                )}
                {step.errorCode && <p className="tool-step-error">{step.errorCode}</p>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
