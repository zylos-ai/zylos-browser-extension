import { useEffect, useState } from 'react';
import { useAgent } from '../hooks/useAgent';
import { ConnectionCard } from './ConnectionCard';
import { ChatPanel } from './ChatPanel';
export function App() {
  const agent = useAgent();
  const { state, error, request, reportError, clearError, windowId } = agent;
  const [settings, setSettings] = useState(false);
  useEffect(() => {
    if (state.ready) setSettings(false);
  }, [state.ready]);
  const action = (type: 'disconnect' | 'reconnect') => {
    clearError();
    void request({ type }).catch(reportError);
  };
  return (
    <div className={state.ready ? 'connected app' : 'app'}>
      <header>
        <h1 className="brand">coco</h1>
        <div className="header-actions">
          <span className="pill" id="connection" role="status">
            {state.ready ? '已连接' : state.connecting ? '连接中' : '离线'}
          </span>
          <button
            id="side-panel"
            className="link"
            disabled={windowId === undefined}
            onClick={() => {
              if (windowId !== undefined)
                void chrome.sidePanel.open({ windowId }).catch(reportError);
            }}
          >
            侧边栏
          </button>
          <button
            className="link"
            aria-expanded={settings}
            aria-controls="settings"
            onClick={() => setSettings(!settings)}
          >
            {settings ? '返回对话' : '设置'}
          </button>
        </div>
      </header>
      <aside className="connection-feedback" aria-live="polite">
        <p id="error" role="alert">
          {error}
        </p>
        {state.hasSavedConnection && !state.ready && (
          <div className="offline-notice">
            <span>
              {state.connecting ? '正在重新连接，草稿会保留。' : '连接暂时断开，草稿会保留。'}
            </span>
            <button
              id="reconnect"
              className="link"
              disabled={state.connecting}
              onClick={() => action('reconnect')}
            >
              重新连接
            </button>
          </div>
        )}
      </aside>
      {(settings || (!state.hasSavedConnection && !state.ready)) && (
        <section id="settings" aria-label="配对设置">
          <ConnectionCard agent={agent} />
          {state.hasSavedConnection && (
            <button
              id="disconnect"
              className="link"
              disabled={!state.hasSavedConnection && !state.connecting}
              onClick={() => action('disconnect')}
            >
              断开并忘记配对
            </button>
          )}
        </section>
      )}
      <main>
        <ChatPanel agent={agent} />
      </main>
    </div>
  );
}
