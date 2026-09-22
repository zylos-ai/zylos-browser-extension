import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { REPLY_NOTICE_MS, type RemoteState } from '../utils/remote';
import { Brand } from './Brand';
import { useI18n } from './LanguageProvider';
import { formatMessageDate } from '../utils/i18n';
import { ToolSteps } from './ToolSteps';
import { MarkdownMessage } from './MarkdownMessage';

const dayKey = (ts: number) => new Date(ts).toDateString();

export function Conversation({
  state,
  onStarter,
}: {
  state: RemoteState;
  onStarter: (value: string) => void;
}) {
  const { t, locale, errorText } = useI18n();
  const starters = [t('starterResearch'), t('starterCompare'), t('starterForm')];
  const historyRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  const { chat, task } = state;
  const latest = chat.at(-1);
  const activity = [...chat].reverse().find((message) => message.toolRun)?.toolRun;
  const activityRevision = activity && JSON.stringify(activity);
  const turn = [...chat]
    .reverse()
    .find(
      (message) =>
        message.role === 'user' || (message.role === 'assistant' && message.final !== false),
    );
  const progress = [...chat]
    .reverse()
    .find((message) => message.role === 'assistant' && message.final === false);
  const hasProgress = !!progress && !!turn && chat.indexOf(progress) > chat.indexOf(turn);
  const turnActivity =
    turn &&
    chat
      .slice(chat.indexOf(turn) + 1)
      .flatMap((message) => (message.toolRun ? [message.toolRun] : []));
  const browserActivityTs = Math.max(
    0,
    ...(turnActivity ?? []).flatMap((run) => [
      run.startedAt,
      run.endedAt ?? 0,
      ...run.steps.map((step) => step.endedAt ?? step.startedAt ?? step.queuedAt),
    ]),
  );
  const browserBusy = (turnActivity ?? []).some(
    (run) =>
      run.status === 'running' &&
      run.steps.some((step) => step.status === 'running' || step.status === 'queued'),
  );
  const hasBrowserActivity = browserActivityTs > 0;
  const activityTs = Math.max(hasProgress ? progress!.ts : (turn?.ts ?? 0), browserActivityTs);
  const [now, setNow] = useState(Date.now);
  const awaiting =
    turn?.role === 'user' &&
    turn.delivery !== 'failed' &&
    turn.delivery !== 'unknown' &&
    (!turn.loopStatus || turn.loopStatus === 'active');
  const delayed = awaiting && !browserBusy && now - activityTs >= REPLY_NOTICE_MS;
  useEffect(() => {
    setNow(Date.now());
    if (!awaiting) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, activityTs + REPLY_NOTICE_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [awaiting, activityTs]);

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
    latest?.final,
    chat.length,
    task?.sessionId,
    task?.phase,
    delayed,
    activityRevision,
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
              <Fragment
                key={message.id ? `${message.role}-${message.id}` : `${message.ts}-${index}`}
              >
                {(index === 0 || dayKey(chat[index - 1]!.ts) !== dayKey(message.ts)) && (
                  <p className="message-date text-caption text-muted">
                    {formatMessageDate(message.ts, locale)}
                  </p>
                )}
                {message.toolRun ? (
                  <ToolSteps run={message.toolRun} />
                ) : (
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
                    {message.role === 'system' && (
                      <span className="system-label">{t('system')}</span>
                    )}
                    {message.role === 'assistant' ? (
                      <MarkdownMessage text={message.text} />
                    ) : (
                      <p className="message-text">{message.text}</p>
                    )}
                    {message.role === 'user' && message.deliveryError && (
                      <p className="message-delivery" role="alert">
                        {errorText(message.deliveryError)}
                      </p>
                    )}
                  </article>
                )}
              </Fragment>
            ))}
          </div>
        )}
        {awaiting && (
          <p className="reply-status" role="status">
            {!state.connected
              ? t('replyDisconnected')
              : browserBusy
                ? t('replyBrowserWorking')
                : delayed
                  ? t('replyDelayed')
                  : hasBrowserActivity
                    ? t('replyBrowserProgress')
                    : hasProgress
                      ? t('replyProgress')
                      : turn?.delivery === 'queued'
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
