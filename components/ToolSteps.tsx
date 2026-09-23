import { useEffect, useId, useState } from 'react';
import { summarizeTools, stageLabels } from '../utils/tool-progress';
import type { TranslationKey } from '../utils/i18n';
import {
  AGENT_ACTIVITY_TTL_MS,
  agentActivityLabels,
  type AgentActivity,
} from '../utils/agent-activity';
import type { ToolRun } from '../utils/remote';
import { useI18n } from './LanguageProvider';

function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function hostname(target: string) {
  try {
    return new URL(target).hostname;
  } catch {
    return '';
  }
}

export function ToolSteps({
  run,
  startedAt = run.startedAt,
  className = '',
  label,
  agentActivity,
}: {
  run: ToolRun;
  startedAt?: number;
  className?: string;
  label?: TranslationKey;
  agentActivity?: AgentActivity;
}) {
  const { t } = useI18n();
  const listId = useId();
  const [toggle, setToggle] = useState<{ phase: ToolRun['status']; open: boolean }>();
  const open = toggle?.phase === run.status ? toggle.open : false;
  const [now, setNow] = useState(Date.now);
  const active = run.status === 'running';
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  const progress = summarizeTools(run, now);
  const overview = progress.stages.filter((stage) => stage.kind !== 'preparing');
  const latestSummary = [...run.steps]
    .reverse()
    .find((step) => !step.replayed && typeof step.summary === 'string')?.summary;
  const statusLabel =
    label ??
    (run.status === 'stopped'
      ? 'activityStopped'
      : run.status === 'interrupted'
        ? 'progressEnded'
        : active
          ? progress.hasExecution
            ? 'progressWorking'
            : 'progressAwaiting'
          : null);
  const remoteActivity =
    agentActivity &&
    agentActivity.category !== 'idle' &&
    now - agentActivity.receivedAt < AGENT_ACTIVITY_TTL_MS
      ? agentActivity
      : undefined;
  const remoteLabel =
    remoteActivity &&
    (remoteActivity.phase === 'returned'
      ? now - remoteActivity.receivedAt < 2500
        ? t('agentReturned')
        : t('agentProcessing')
      : t(agentActivityLabels[remoteActivity.category]));
  // Browser actions are the most specific evidence while Chrome is executing.
  // Between actions show the latest real Agent event, replacing the same line.
  const title =
    active && !label
      ? progress.busy && progress.hasExecution
        ? t(progress.phaseLabel)
        : remoteLabel
          ? `${remoteLabel}${remoteActivity?.detail && (remoteActivity.phase !== 'returned' || now - remoteActivity.receivedAt < 2500) ? ` · ${remoteActivity.detail}` : ''}`
          : latestSummary ||
            (progress.hasExecution
              ? t(progress.phaseLabel)
              : agentActivity
                ? t('agentAwaitingResponse')
                : t('progressAwaiting'))
      : statusLabel
        ? t(statusLabel)
        : '';
  const timing = elapsed((run.endedAt ?? now) - startedAt);
  const heading = (
    <>
      {active && <span className="tool-activity-dot" aria-hidden="true" />}
      {title && (
        <span className="tool-activity-title" title={title}>
          {title}
        </span>
      )}
      {title && (
        <span className="tool-activity-separator" aria-hidden="true">
          ·
        </span>
      )}
      <span className="tool-activity-time" aria-hidden={active || undefined}>
        {active ? timing : t('progressElapsed', { time: timing })}
      </span>
      {overview.length > 0 && (
        <svg
          className="tool-activity-chevron"
          data-open={open}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m4.5 3 3 3-3 3"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </>
  );

  return (
    <section
      className={`tool-activity ${className}`}
      data-status={run.status}
      aria-label={t('progressTitle')}
    >
      {overview.length > 0 ? (
        <button
          type="button"
          className="tool-activity-toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setToggle({ phase: run.status, open: !open })}
        >
          {heading}
        </button>
      ) : (
        <div className="tool-activity-toggle" role={active ? 'status' : undefined}>
          {heading}
        </div>
      )}
      {overview.length > 0 && (
        <div id={listId} hidden={!open} className="tool-activity-body">
          <ol className="tool-overview" aria-label={t('progressOverview')}>
            {overview.map((stage) => (
              <li key={stage.id}>
                <span className="tool-overview-label">{t(stageLabels[stage.kind])}</span>
                {stage.target && (
                  <span className="tool-overview-site">{hostname(stage.target)}</span>
                )}
                {stage.summary && <p className="tool-overview-summary">{stage.summary}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
