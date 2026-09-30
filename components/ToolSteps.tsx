import { useEffect, useId, useRef, useState } from 'react';
import { summarizeTools } from '../utils/tool-progress';
import type { TranslationKey } from '../utils/i18n';
import {
  AGENT_ACTIVITY_TTL_MS,
  agentActivityLabels,
  type AgentActivity,
  type AgentHistory,
} from '../utils/agent-activity';
import type { ToolRun } from '../utils/remote';
import { useI18n } from './LanguageProvider';

function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function ToolSteps({
  run,
  startedAt = run.startedAt,
  className = '',
  label,
  agentActivity,
  history,
}: {
  run: ToolRun;
  startedAt?: number;
  className?: string;
  label?: TranslationKey;
  agentActivity?: AgentActivity;
  history?: AgentHistory;
}) {
  const { t } = useI18n();
  const listId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
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
  const events = history?.events ?? [];
  const lastEvent = events.at(-1);
  useEffect(() => {
    const body = bodyRef.current;
    if (open && following.current && body) body.scrollTop = body.scrollHeight;
  }, [open, events.length, lastEvent]);
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
      ? history
        ? remoteLabel
          ? `${remoteLabel}${remoteActivity?.detail ? ` · ${remoteActivity.detail}` : ''}`
          : lastEvent?.kind === 'commentary'
            ? lastEvent.text
            : events.length || agentActivity
              ? t('agentAwaitingResponse')
              : t('progressAwaiting')
        : progress.busy && progress.hasExecution
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
      {
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
      }
    </>
  );

  return (
    <section
      className={`tool-activity ${className}`}
      data-status={run.status}
      aria-label={t('agentThinking')}
    >
      {
        <button
          type="button"
          className="tool-activity-toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => {
            following.current = true;
            setToggle({ phase: run.status, open: !open });
          }}
        >
          {heading}
        </button>
      }
      <div
        ref={bodyRef}
        id={listId}
        hidden={!open}
        className="tool-activity-body"
        onScroll={() => {
          const body = bodyRef.current;
          if (body) following.current = body.scrollHeight - body.scrollTop - body.clientHeight < 32;
        }}
      >
        {!!history?.dropped && (
          <p className="agent-history-note">
            {t('agentHistoryTrimmed', { count: history.dropped })}
          </p>
        )}
        {!events.length && (
          <p className="agent-history-note">
            {t(active ? 'agentHistoryWaiting' : 'agentHistoryEmpty')}
          </p>
        )}
        <ol className="agent-history" aria-label={t('agentThinking')}>
          {events.map((event) => (
            <li key={event.id} data-kind={event.kind}>
              {event.kind === 'commentary' ? (
                <p className="agent-commentary">{event.text}</p>
              ) : (
                <div className="agent-history-tool">
                  <span>{t(agentActivityLabels[event.category])}</span>
                  {event.tool && <code>{event.tool}</code>}
                  {event.detail && <span>{event.detail}</span>}
                  {event.endedAt !== undefined && (
                    <span className="agent-tool-duration">{elapsed(event.endedAt - event.at)}</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
