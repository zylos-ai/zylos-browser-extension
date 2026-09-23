import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { type RemoteState } from '../utils/remote';
import { Brand } from './Brand';
import { WelcomeMascot } from './WelcomeMascot';
import { useI18n } from './LanguageProvider';
import { formatMessageDate } from '../utils/i18n';
import { ToolSteps } from './ToolSteps';
import { MarkdownMessage } from './MarkdownMessage';
import { formatTaskNotice } from '../utils/task-notice';

const dayKey = (ts: number) => new Date(ts).toDateString();

export function Conversation({
  state,
  onStarter,
}: {
  state: RemoteState;
  onStarter: (value: string) => void;
}) {
  const { t, locale, errorText } = useI18n();
  const starters = [t('starterSummary'), t('starterVideo'), t('starterCompare')];
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
  const turnActivity =
    turn &&
    chat
      .slice(chat.indexOf(turn) + 1)
      .flatMap((message) => (message.toolRun ? [message.toolRun] : []));
  const awaiting =
    turn?.role === 'user' &&
    turn.delivery !== 'failed' &&
    turn.delivery !== 'unknown' &&
    (!turn.loopStatus || turn.loopStatus === 'active');
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
              <WelcomeMascot />
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
                  <ToolSteps
                    run={message.toolRun}
                    startedAt={chat.slice(0, index).findLast((entry) => entry.role === 'user')?.ts}
                  />
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
                    {message.role !== 'user' && message.notice ? (
                      <p className="message-text">{formatTaskNotice(locale, message.notice)}</p>
                    ) : message.role === 'assistant' ? (
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
        {awaiting && !turnActivity?.length && (
          <ToolSteps
            className="reply-status"
            label={!state.connected ? 'progressDisconnected' : undefined}
            run={{
              status: state.connected ? 'running' : 'interrupted',
              startedAt: turn.ts,
              total: 0,
              failed: 0,
              steps: [],
            }}
          />
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
