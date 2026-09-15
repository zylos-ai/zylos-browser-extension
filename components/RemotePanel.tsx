import { useEffect, useRef, useState } from 'react';
import {
  initialRemoteState,
  remoteStateSchema,
  type RemoteState,
  type RemoteRequest,
} from '../utils/remote';
import { useI18n } from './LanguageProvider';
import { ChatComposer } from './ChatComposer';
import { Conversation } from './Conversation';
import { ConnectionSettings } from './ConnectionSettings';

/** Owns the sidebar state; all browser operations still run in the background. */
export function RemotePanel() {
  const { t, errorText } = useI18n();
  const [state, setState] = useState<RemoteState>(initialRemoteState);
  const [draft, setDraft] = useState('');
  const [screen, setScreen] = useState<'loading' | 'chat' | 'settings'>('loading');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<RemoteRequest['type'] | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const pendingRef = useRef(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  async function request(message: RemoteRequest): Promise<RemoteState | null> {
    try {
      const response = await chrome.runtime.sendMessage(message);
      const parsed = response?.ok && remoteStateSchema.safeParse(response.value);
      if (parsed && parsed.success) {
        setState(parsed.data);
        setError('');
        return parsed.data;
      }
      setError(response?.error || 'ui.error.operationFailed');
    } catch {
      setError('ui.error.serviceUnavailable');
    }
    return null;
  }

  useEffect(() => {
    let active = true;
    const listener = (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'remote-updated' &&
        'state' in message
      ) {
        const parsed = remoteStateSchema.safeParse(message.state);
        if (parsed.success) setState(parsed.data);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    void request({ type: 'remote-state' }).then((value) => {
      if (active) setScreen(value?.configured ? 'chat' : 'settings');
    });
    return () => {
      active = false;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  async function sendChat() {
    const text = draft.trim();
    if (!state.connected || !text || sendingRef.current) return;
    const submittedDraft = draft;
    sendingRef.current = true;
    setSending(true);
    const ok = await request({ type: 'remote-chat-send', text });
    sendingRef.current = false;
    setSending(false);
    if (ok) setDraft((current) => (current === submittedDraft ? '' : current));
  }

  async function action(message: RemoteRequest) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(message.type);
    const result = await request(message);
    pendingRef.current = false;
    setPending(null);
    return !!result;
  }

  const connected = state.connected;
  const status = !state.configured
    ? t('notConnected')
    : !state.enabled
      ? t('disabled')
      : connected
        ? t('connected')
        : state.connecting
          ? t('connecting')
          : t('offline');
  const settingsOpen = screen === 'settings';
  const visibleError = error || state.error;

  return (
    <div className={`app${connected ? ' connected' : ''}`}>
      <header className="sidebar-header">
        <div className="header-actions">
          <span
            className={`connection-status${connected ? ' is-connected' : ''}`}
            title={state.relayHost}
            role="status"
          >
            <span className="status-dot" aria-hidden="true" />
            {status}
          </span>
          <button
            ref={settingsButtonRef}
            className="btn btn-ghost settings-button"
            onClick={() => {
              setScreen(settingsOpen ? 'chat' : 'settings');
              setError('');
            }}
            aria-expanded={settingsOpen}
            aria-controls={settingsOpen ? 'settings' : undefined}
          >
            {settingsOpen ? t('back') : t('settings')}
          </button>
        </div>
      </header>
      {visibleError && (
        <div className="connection-feedback">
          <p id="error" role="alert">
            {errorText(visibleError)}
          </p>
        </div>
      )}
      {screen === 'loading' ? (
        <main className="loading-page" role="status">
          <span className="loading loading-spinner loading-sm" />
          {t('loading')}
        </main>
      ) : settingsOpen ? (
        <ConnectionSettings
          state={state}
          saving={pending === 'remote-save'}
          pending={pending !== null}
          onSave={async (relayUrl, key) => {
            const ok = await action({ type: 'remote-save', relayUrl, key });
            if (ok) {
              setScreen('chat');
              settingsButtonRef.current?.focus();
            }
            return ok;
          }}
          onToggle={() => void action({ type: 'remote-set-enabled', enabled: !state.enabled })}
          onClear={() => void action({ type: 'remote-chat-clear' })}
        />
      ) : (
        <main className="chat-panel">
          {!connected && (
            <div className="offline-notice" role="status">
              <span>
                {!state.configured
                  ? t('connectFirst')
                  : !state.enabled
                    ? t('extensionDisabled')
                    : state.connecting
                      ? t('connectingAgent')
                      : t('reconnecting')}
              </span>
              <button className="btn btn-ghost" onClick={() => setScreen('settings')}>
                {t('connectionSettings')}
              </button>
            </div>
          )}
          <Conversation
            state={state}
            onStarter={(text) => {
              setDraft(text);
              inputRef.current?.focus();
            }}
            onReveal={() => void request({ type: 'remote-reveal' })}
            onStop={() => void action({ type: 'remote-stop' })}
            stopping={pending === 'remote-stop'}
          />
          <ChatComposer
            draft={draft}
            onDraftChange={setDraft}
            connected={connected}
            sending={sending}
            onSend={() => void sendChat()}
            inputRef={inputRef}
          />
        </main>
      )}
    </div>
  );
}
