import { useEffect, useRef, useState } from 'react';
import completedIcon from '../assets/preview/completed.svg';
import activeIcon from '../assets/preview/active.svg';
import {
  PREVIEW_PORT,
  previewMessageSchema,
  type PreviewFrame,
  type PreviewState,
} from '../utils/live-preview';
import type { RemoteState } from '../utils/remote';
import { useI18n } from './LanguageProvider';

export function LivePreview({
  task,
  onReveal,
  onStop,
  stopping,
}: {
  task: RemoteState['task'];
  onReveal: () => void;
  onStop: () => void;
  stopping: boolean;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<PreviewState | null | undefined>();
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const visibility = () => {
      try {
        portRef.current?.postMessage({
          type: 'visibility',
          visible: document.visibilityState !== 'hidden',
        });
      } catch {
        /* The disconnect listener reconnects after the worker restarts. */
      }
    };
    function connect() {
      if (disposed) return;
      try {
        const port = chrome.runtime.connect({ name: PREVIEW_PORT });
        portRef.current = port;
        port.onMessage.addListener((raw: unknown) => {
          if (disposed || portRef.current !== port) return;
          const parsed = previewMessageSchema.safeParse(raw);
          if (!parsed.success) return;
          if (parsed.data.type === 'preview-state') {
            const next = parsed.data.preview;
            setPreview(next);
            setFrame((old) => (old?.targetKey === next?.targetKey ? old : null));
          } else setFrame(parsed.data.frame);
        });
        port.onDisconnect.addListener(() => {
          if (disposed || portRef.current !== port) return;
          // Reading lastError consumes Chrome's disconnected-port diagnostic.
          void chrome.runtime.lastError;
          portRef.current = null;
          setPreview(undefined);
          setFrame(null);
          retry = setTimeout(connect, 1000);
        });
        visibility();
      } catch {
        retry = setTimeout(connect, 1000);
      }
    }
    connect();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', visibility);
      try {
        portRef.current?.disconnect();
      } catch {
        /* Already disconnected. */
      }
      portRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!frame) return;
    const id = requestAnimationFrame(() => {
      try {
        portRef.current?.postMessage({ type: 'ack', sequence: frame.sequence });
      } catch {
        /* Already disconnected. */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [frame]);

  // Keep View/Stop usable even when the preview service is starting or unavailable.
  const state =
    preview ??
    (task
      ? ({
          targetKey: '',
          title: task.title,
          url: task.url,
          tabId: task.tabId,
          status: task.phase === 'paused' || task.phase === 'finished' ? 'paused' : 'running',
          availability: 'connecting',
          canReveal: true,
          canStop: true,
        } as const)
      : null);
  if (!state) return null;
  const image = frame?.targetKey === state.targetKey ? frame : null;
  const done = state.status === 'completed';
  const label = done
    ? t('previewCompleted')
    : state.status === 'stopped'
      ? t('previewStopped')
      : state.status === 'interrupted'
        ? t('previewInterrupted')
        : state.status === 'error'
          ? t('previewError')
          : state.status === 'paused' || state.availability === 'paused'
            ? t('previewPaused')
            : state.availability === 'live'
              ? t('previewLive')
              : state.availability === 'unavailable'
                ? t('previewUnavailable')
                : t('previewConnecting');

  return (
    <section
      className="live-preview"
      data-status={state.status}
      data-phase={task?.phase}
      data-availability={state.availability}
      data-tab-id={state.tabId}
      data-frame-sequence={image?.sequence ?? 0}
      aria-label={t('previewLabel')}
      tabIndex={0}
    >
      <div className="live-preview-viewport">
        {image ? (
          <img
            className="live-preview-image"
            src={image.dataUrl}
            alt={t('previewImage', { title: state.title })}
          />
        ) : (
          <p className="live-preview-placeholder">
            {t(state.availability === 'unavailable' ? 'previewNoFrame' : 'previewWaitingFrame')}
          </p>
        )}
        {done && (
          <img
            className="live-preview-completed"
            src={completedIcon}
            width="28"
            height="28"
            alt={t('previewCompleted')}
          />
        )}
        <div className="live-preview-actions">
          <button
            type="button"
            className="btn preview-view"
            onClick={onReveal}
            disabled={!state.canReveal}
            title={t(state.canReveal ? 'previewViewTab' : 'previewTabClosed')}
          >
            {t('previewView')}
          </button>
          {state.canStop && (
            <button
              type="button"
              id="stop-task"
              className="btn preview-stop"
              onClick={onStop}
              disabled={stopping}
              aria-label={stopping ? t('stopping') : t('stopTask')}
            >
              {stopping ? t('stopping') : t('previewStop')}
            </button>
          )}
        </div>
      </div>
      <div className="live-preview-footer">
        {state.status === 'running' ? (
          <img src={activeIcon} width="6" height="6" alt="" />
        ) : (
          <span className="status-dot" aria-hidden="true" />
        )}
        <span className="live-preview-title" title={`${state.title}\n${state.url}`}>
          {state.title || t('browserTask')}
        </span>
        <span className="live-preview-status" role="status">
          {label}
        </span>
      </div>
    </section>
  );
}
