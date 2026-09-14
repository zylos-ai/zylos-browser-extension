import { useEffect, useRef, useState } from 'react';
import { initialRemoteState, remoteStateSchema, type RemoteState } from '../utils/remote';

// Chat-first side panel for the zylos-remote transport: talk to the agent,
// watch the task tab, flip the kill switch. Settings (relay URL + key) fold
// away once configured.
export function RemotePanel() {
  const [state, setState] = useState<RemoteState>(initialRemoteState);
  const [draft, setDraft] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [key, setKey] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);

  async function request(message: unknown): Promise<boolean> {
    try {
      const r = await chrome.runtime.sendMessage(message);
      if (r?.ok) {
        const parsed = remoteStateSchema.safeParse(r.value);
        if (parsed.success) setState(parsed.data);
        return true;
      }
      setState((s) => ({ ...s, error: r?.error || '操作失败' }));
      return false;
    } catch {
      setState((s) => ({ ...s, error: '插件服务不可用，请重新打开面板' }));
      return false;
    }
  }

  useEffect(() => {
    const listener = (m: unknown) => {
      if (
        m &&
        typeof m === 'object' &&
        'type' in m &&
        m.type === 'remote-updated' &&
        'state' in m
      ) {
        const parsed = remoteStateSchema.safeParse(m.state);
        if (parsed.success) setState(parsed.data);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    void request({ type: 'remote-state' });
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    if (!state.configured) setSettingsOpen(true);
  }, [state.configured]);

  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.chat.length]);

  async function sendChat() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const ok = await request({ type: 'remote-chat-send', text });
    setSending(false);
    if (ok) setDraft('');
  }

  async function saveSettings() {
    const ok = await request({ type: 'remote-save', relayUrl, key });
    if (ok) {
      setKey('');
      setSettingsOpen(false);
    }
  }

  const pill = !state.configured
    ? '未配置'
    : !state.enabled
      ? '已停用'
      : state.connected
        ? '已连接'
        : state.connecting
          ? '连接中…'
          : '离线';

  return (
    <div className={`app${state.connected ? ' connected' : ''}`}>
      <header>
        <h1 className="brand">coco</h1>
        <div className="header-actions">
          <span className="pill" title={state.relayHost}>
            {pill}
          </span>
          <button
            className="link"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
          >
            设置
          </button>
        </div>
      </header>

      {settingsOpen && (
        <section id="settings">
          <h2>连接 Agent</h2>
          <p className="hint">
            填入 Agent 侧给你的 relay 地址和 key。key 只保存在本机，插件不会把它发给除 relay
            以外的任何地方。
          </p>
          <label>
            Relay 地址
            <input
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder={
                state.relayHost
                  ? `wss://${state.relayHost}/…`
                  : 'wss://your-agent.example/browser-remote/ext'
              }
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            Key
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={state.keyId ? `已保存（keyId ${state.keyId}）` : '64 位十六进制'}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="row">
            <button onClick={() => void saveSettings()} disabled={!relayUrl || !key}>
              保存并连接
            </button>
            {state.configured && (
              <button
                className="secondary"
                onClick={() =>
                  void request({ type: 'remote-set-enabled', enabled: !state.enabled })
                }
              >
                {state.enabled ? '停用插件' : '启用插件'}
              </button>
            )}
            {state.chat.length > 0 && (
              <button className="link" onClick={() => void request({ type: 'remote-chat-clear' })}>
                清空对话
              </button>
            )}
          </div>
          {state.keyId && <p className="hint">keyId：{state.keyId}（Agent 用它识别这台浏览器）</p>}
        </section>
      )}

      <div className="connection-feedback">
        <p id="error" role="alert">
          {state.error}
        </p>
      </div>

      {state.task && (
        <div className="task-actions">
          <span title={state.task.url}>
            Agent 正在操作 · {state.task.tabCount} 个工作标签
            {state.task.title ? ` · ${state.task.title.slice(0, 40)}` : ''}
          </span>
          <span>
            <button className="link" onClick={() => void request({ type: 'remote-reveal' })}>
              查看
            </button>
            <button className="link danger" onClick={() => void request({ type: 'remote-stop' })}>
              停止
            </button>
          </span>
        </div>
      )}

      <main>
        <section className="chat-panel">
          <div id="history" ref={historyRef}>
            {state.chat.length === 0 ? (
              <div className="empty-chat">
                <p>
                  {state.connected
                    ? '在这里给 Agent 发消息，它会在旁边新开的工作标签里操作浏览器。'
                    : state.configured
                      ? '等待连接 relay…'
                      : '先在「设置」里填入 relay 地址和 key。'}
                </p>
              </div>
            ) : (
              state.chat.map((m, i) => (
                <div key={`${m.ts}-${i}`} className={`message ${m.role}`}>
                  <small>
                    {m.role === 'user' ? '你' : m.role === 'assistant' ? 'Agent' : '系统'}
                  </small>
                  {m.text}
                </div>
              ))
            )}
          </div>
          <form
            id="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              void sendChat();
            }}
          >
            <textarea
              id="message"
              value={draft}
              disabled={!state.connected}
              placeholder={
                state.connected ? '想让 Agent 做什么？Enter 发送，Shift+Enter 换行' : '未连接'
              }
              onChange={(e) => setDraft(e.target.value)}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !composing.current &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void sendChat();
                }
              }}
            />
            <button id="send" type="submit" disabled={!state.connected || !draft.trim() || sending}>
              发送
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
