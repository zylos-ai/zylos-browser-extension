import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../hooks/useAgent';
import { AuthorizationCard } from './AuthorizationCard';
export function ChatPanel({ agent }: { agent: Agent }) {
  const { state, request, reportError, clearError } = agent;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const history = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [state.history, state.authorization?.id, state.authorization?.status]);
  return (
    <section className="chat-panel" aria-label="聊天">
      <div id="history" ref={history} role="log" aria-label="对话记录" aria-live="polite">
        {state.history.length ? (
          state.history.map((entry) => (
            <div key={entry.id} className={'message ' + entry.role}>
              <small>{entry.role === 'user' ? '你' : 'Agent'}</small>
              <span>{entry.text}</span>
            </div>
          ))
        ) : (
          <div className="empty-chat">
            <h2>有什么可以帮你？</h2>
            <p>
              直接说出需求。需要操作网页时，
              <br />
              会在对话中请你授权。
            </p>
          </div>
        )}
        <AuthorizationCard key={state.authorization?.id} agent={agent} />
      </div>
      {(state.control || ['pending', 'approving'].includes(state.authorization?.status || '')) && (
        <div className="task-actions" aria-label="浏览器操作">
          {state.control ? (
            <button
              id="reveal-task"
              className="link"
              onClick={() => {
                clearError();
                void request({ type: 'reveal-task' }).catch(reportError);
              }}
            >
              查看工作标签
            </button>
          ) : (
            <span>等待你的授权</span>
          )}
          <button
            id="stop"
            className="link danger"
            onClick={() => {
              clearError();
              void request({ type: 'stop' }).catch(reportError);
            }}
          >
            停止控制
          </button>
        </div>
      )}
      <form
        id="chat-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!state.ready || !draft.trim() || sending) return;
          const submitted = draft;
          setSending(true);
          clearError();
          try {
            await request({ type: 'chat', text: submitted });
            setDraft((current) => (current === submitted ? '' : current));
          } catch (error) {
            reportError(error);
          } finally {
            setSending(false);
          }
        }}
      >
        <textarea
          id="message"
          aria-label="给 Agent 的消息"
          placeholder="让 Agent 帮你做些什么…"
          rows={3}
          maxLength={12000}
          required
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button id="send" type="submit" disabled={!state.ready || sending}>
          {sending ? '发送中…' : '发送消息 ↗'}
        </button>
      </form>
    </section>
  );
}
