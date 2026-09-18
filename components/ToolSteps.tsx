import { useEffect, useId, useState } from 'react';
import { LONG_WAIT_MS, stageLabels, summarizeTools } from '../utils/tool-progress';
import type { TranslationKey } from '../utils/i18n';
import type { ToolRun, ToolStep } from '../utils/remote';
import type { BrowserMethod } from '../utils/tool-catalog';
import { useI18n } from './LanguageProvider';

const labels = {
  'use-current-tab': 'toolUseCurrentTab',
  open: 'toolOpen',
  'new-tab': 'toolNewTab',
  'switch-tab': 'toolSwitchTab',
  tabs: 'toolTabs',
  frames: 'toolFrames',
  snapshot: 'toolSnapshot',
  observe: 'toolObserve',
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
} satisfies Record<BrowserMethod, TranslationKey>;
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
  const [toggle, setToggle] = useState<{ phase: ToolRun['status']; open: boolean }>();
  const open = toggle?.phase === run.status ? toggle.open : false;
  const [, setClock] = useState(0);
  const waitAt =
    run.status === 'running'
      ? Math.min(
          ...run.steps
            .filter((s) => s.method === 'wait' && s.status === 'running')
            .map((s) => (s.startedAt ?? s.queuedAt) + LONG_WAIT_MS),
        )
      : Infinity;
  // One timer at the long-wait boundary; no polling or extra Agent requests.
  useEffect(() => {
    const delay = waitAt - Date.now();
    if (!Number.isFinite(delay) || delay < 0) return;
    const timer = setTimeout(() => setClock((n) => n + 1), delay + 1);
    return () => clearTimeout(timer);
  }, [waitAt]);
  const progress = summarizeTools(run);
  const successful = run.status === 'completed' && !progress.hasIssues;
  const attention = progress.hasIssues && run.status !== 'stopped';
  return (
    <section
      className="tool-activity"
      data-status={run.status}
      data-outcome={attention ? 'attention' : successful ? 'success' : undefined}
      aria-label={t('activityTitle')}
    >
      <button
        type="button"
        className="tool-activity-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setToggle({ phase: run.status, open: !open })}
      >
        <span className={`tool-activity-icon ${progress.busy ? 'is-busy' : ''}`} aria-hidden="true">
          {successful ? '✓' : attention && !progress.busy ? '!' : '≡'}
        </span>
        <span className="tool-activity-heading">
          <span className="tool-activity-title">{t(progress.label)}</span>
          <span className="tool-activity-summary">
            {t('activityTitle')}
            {progress.stages.length > 0 && (
              <span className="tool-activity-count">
                {t(run.total > run.steps.length ? 'activityRecentCount' : 'activityCount', {
                  count: progress.stages.length,
                })}
              </span>
            )}
            {run.endedAt !== undefined && ` · ${duration(run.endedAt - run.startedAt)}`}
            {attention && run.status === 'running' && (
              <span className="tool-activity-failures">
                {' · '}
                {t('activityIssues')}
              </span>
            )}
          </span>
        </span>
        <span className="tool-activity-chevron" aria-hidden="true">
          {open ? '⌃' : '⌄'}
        </span>
      </button>
      <div id={listId} hidden={!open} className="tool-activity-body">
        {progress.stages.length === 0 && (
          <p className="tool-activity-note">{t('activityNoStages')}</p>
        )}
        {progress.omittedErrors > 0 && (
          <p className="tool-activity-failures tool-activity-note">{t('activityEarlierIssues')}</p>
        )}
        <ol className="tool-step-list tool-stage-list" aria-label={t('activityStages')}>
          {progress.stages.map((stage, index) => (
            <li key={stage.id} className="tool-step tool-stage" data-status={stage.status}>
              <span className="tool-step-marker" aria-hidden="true">
                {stage.status === 'success' ? '✓' : stage.status === 'error' ? '!' : index + 1}
              </span>
              <div className="tool-step-content">
                <div className="tool-step-heading">
                  <span className="tool-step-label">{t(stageLabels[stage.kind])}</span>
                  <span className="tool-step-status">
                    {t(stage.status === 'error' ? 'stageIssue' : statuses[stage.status])}
                  </span>
                </div>
                {stage.target && (
                  <p className="tool-step-target" title={stage.target}>
                    {stage.target}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
        <details className="tool-diagnostics" key={run.status}>
          <summary>
            {t('activityLog')} · {t('activityCalls', { count: run.total })}
          </summary>
          {run.total > run.steps.length && (
            <p className="tool-activity-note">
              {t('activityOmitted', {
                count: run.steps.length,
                omitted: run.total - run.steps.length,
              })}
            </p>
          )}
          <ol className="tool-step-list tool-raw-list" aria-label={t('activityLog')}>
            {run.steps.map((step) => (
              <li key={step.id} className="tool-step tool-log-step" data-status={step.status}>
                <span className="tool-step-marker" aria-hidden="true">
                  {step.status === 'success' ? '✓' : step.status === 'error' ? '!' : step.number}
                </span>
                <div className="tool-step-content">
                  <div className="tool-step-heading">
                    <span className="tool-step-label">
                      {Object.hasOwn(labels, step.method)
                        ? t(labels[step.method as BrowserMethod])
                        : step.method}
                    </span>
                    <span className="tool-step-status">
                      {t(step.recovered ? 'stepRecovered' : statuses[step.status])}
                    </span>
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
        </details>
      </div>
    </section>
  );
}
