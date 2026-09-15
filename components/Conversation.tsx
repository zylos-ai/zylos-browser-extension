import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { REPLY_NOTICE_MS, type RemoteState } from '../utils/remote';
import { Brand } from './Brand';
import { useI18n } from './LanguageProvider';
import { formatMessageDate } from '../utils/i18n';

const dayKey = (ts: number) => new Date(ts).toDateString();

export function Conversation({
  state,
  onStarter,
  onReveal,
  onStop,
  stopping,
}: {
  state: RemoteState;
  onStarter: (value: string) => void;
  onReveal: () => void;
  onStop: () => void;
  stopping: boolean;
}) {
  const { t, locale, errorText } = useI18n();
  const starters = [t('starterResearch'), t('starterCompare'), t('starterForm')];
  const historyRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  const { chat, task } = state;
  const latest = chat.at(-1);
  const [now, setNow] = useState(Date.now);
  const awaiting =
    latest?.role === 'user' && latest.delivery !== 'failed' && latest.delivery !== 'unknown';
  const delayed = awaiting && now - latest.ts >= REPLY_NOTICE_MS;
  useEffect(() => {
    setNow(Date.now());
    if (!awaiting) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, latest.ts + REPLY_NOTICE_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [awaiting, latest?.ts]);

  function scrollToLatest() {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    following.current = true;
    setUnread(false);
  }
  useLayoutEffect(() => {
    if (following.current || latest?.role === 'user') scrollToLatest();
    else setUnread(true);
  }, [
    latest?.ts,
    latest?.text,
    latest?.deliveryError,
    chat.length,
    task?.sessionId,
    task?.phase,
    delayed,
  ]);

  return (
    <div className="conversation">
      <div
        id="history"
        ref={historyRef}
        onScroll={() => {
          const el = historyRef.current;
          if (!el) return;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          if (following.current) setUnread(false);
        }}
      >
        {chat.length === 0 && !task ? (
          <section className="empty-chat" aria-labelledby="welcome-title">
            <div className="welcome">
              <Brand large />
              <h1 id="welcome-title" className="text-title">
                {t('welcomeTitle')}
              </h1>
              <p className="text-muted localized-description">{t('welcomeDescription')}</p>
            </div>
            <div className="starter-prompts" aria-label={t('starterLabel')}>
              {starters.map((text) => (
                <button
                  key={text}
                  className="btn btn-ghost starter"
                  onClick={() => onStarter(text)}
                  disabled={!state.connected}
                >
                  <span>{text}</span>
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <div
            className="message-list"
            role="log"
            aria-label={t('chatHistory')}
            aria-live="polite"
            aria-relevant="additions text"
          >
            {chat.map((message, index) => (
              <Fragment key={`${message.ts}-${index}`}>
                {(index === 0 || dayKey(chat[index - 1]!.ts) !== dayKey(message.ts)) && (
                  <p className="message-date text-caption text-muted">
                    {formatMessageDate(message.ts, locale)}
                  </p>
                )}
                <article
                  className={`message ${message.role}`}
                  aria-label={
                    message.role === 'user'
                      ? t('you')
                      : message.role === 'assistant'
                        ? 'Zylos'
                        : t('systemMessage')
                  }
                >
                  {message.role === 'assistant' && (
                    <div className="message-author">
                      <Brand />
                      <span>Zylos</span>
                    </div>
                  )}
                  {message.role === 'system' && <span className="system-label">{t('system')}</span>}
                  <p className="message-text">{message.text}</p>
                  {message.role === 'user' && message.deliveryError && (
                    <p className="message-delivery" role="alert">
                      {errorText(message.deliveryError)}
                    </p>
                  )}
                </article>
              </Fragment>
            ))}
          </div>
        )}
        {task && (
          <section className="card task-card" data-phase={task.phase} aria-label={t('browserTask')}>
            <p className="task-status">
              <span className="status-dot" aria-hidden="true" />
              {t(
                task.phase === 'running'
                  ? 'operatingBrowser'
                  : task.phase === 'paused'
                    ? 'browserPaused'
                    : task.phase === 'finished'
                      ? 'browserFinished'
                      : 'browserReady',
              )}
            </p>
            <p className="task-title" title={task.url}>
              {task.title || t('browserTask')}
            </p>
            <p className="text-caption text-muted">
              {t(task.tabCount === 1 ? 'taskTab' : 'taskTabs', { count: task.tabCount })}
            </p>
            <div className="task-buttons">
              <button className="btn secondary-button" onClick={onReveal}>
                {t('viewTabs')}
              </button>
              <button
                id="stop-task"
                className="btn secondary-button danger-button"
                onClick={onStop}
                disabled={stopping}
              >
                {stopping ? t('stopping') : t('stopTask')}
              </button>
            </div>
          </section>
        )}
        {awaiting && (
          <p className="reply-status" role="status">
            {!state.connected
              ? t('replyDisconnected')
              : delayed
                ? t('replyDelayed')
                : latest.delivery === 'queued'
                  ? t('replyQueued')
                  : t('replyWaiting')}
          </p>
        )}
      </div>
      {unread && (
        <button className="btn new-message-button" onClick={scrollToLatest}>
          {t('newMessages')}
        </button>
      )}
    </div>
  );
}
