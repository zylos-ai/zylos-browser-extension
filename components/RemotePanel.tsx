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
import { LivePreview } from './LivePreview';
import { usePageSelection } from './usePageSelection';
import { SelectionChip } from './SelectionChip';
import { selectionAttachment } from '../utils/attachments';

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
  const sendRevision = useRef(0);
  const pendingRef = useRef(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const { selection, faviconUrl, clearSelection } = usePageSelection(
    state.connected && screen === 'chat',
  );

  async function request(
    message: RemoteRequest,
    current = () => true,
  ): Promise<RemoteState | null> {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!current()) return null;
      const parsed = response?.ok && remoteStateSchema.safeParse(response.value);
      if (parsed && parsed.success) {
        setState(parsed.data);
        setError('');
        return parsed.data;
      }
      setError(response?.error || 'ui.error.operationFailed');
    } catch {
      if (current()) setError('ui.error.serviceUnavailable');
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

  const chatBusy = !!(state.chatBusy || state.loopActive || pending === 'remote-stop');
  const stopping = !!state.stopping || pending === 'remote-stop';

  async function sendChat() {
    const text = draft.trim();
    if (!state.connected || !text || sendingRef.current || chatBusy) return;
    const submittedDraft = draft;
    const submittedSelection = selection;
    sendingRef.current = true;
    const revision = ++sendRevision.current;
    setSending(true);
    try {
      const win = await chrome.windows.getCurrent();
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (revision !== sendRevision.current) return;
      const ok = await request(
        {
          type: 'remote-chat-send',
          message: {
            role: 'user',
            content: [
              { type: 'text', text },
              ...(submittedSelection ? [selectionAttachment(submittedSelection)] : []),
            ],
          },
          windowId: win.id,
          tabId: tab?.id,
        },
        () => revision === sendRevision.current,
      );
      if (ok) {
        setDraft((current) => (current === submittedDraft ? '' : current));
        if (submittedSelection) clearSelection(submittedSelection);
      }
    } catch {
      if (revision === sendRevision.current) setError('ui.error.serviceUnavailable');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function action(message: RemoteRequest) {
    if (pendingRef.current) return false;
    if (message.type === 'remote-stop') sendRevision.current++;
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
          <div className="header-tools">
            {state.configured && (
              <button
                type="button"
                className="btn btn-ghost header-button clear-chat-button"
                disabled={pending !== null || sending || chatBusy || state.chat.length === 0}
                aria-label={t('clearChat')}
                title={chatBusy || sending ? t('clearChatBusy') : t('clearChat')}
                onClick={() => void action({ type: 'remote-chat-clear' })}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5" />
                </svg>
                <span>{t('clearChatShort')}</span>
              </button>
            )}
            <button
              ref={settingsButtonRef}
              type="button"
              className="btn btn-ghost header-button settings-button"
              onClick={() => {
                setScreen(settingsOpen ? 'chat' : 'settings');
                setError('');
              }}
              aria-expanded={settingsOpen}
              aria-controls={settingsOpen ? 'settings' : undefined}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {settingsOpen ? (
                  <path d="m14 6-6 6 6 6" />
                ) : (
                  <>
                    <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
                    <circle cx="15" cy="7" r="2" />
                    <circle cx="9" cy="17" r="2" />
                  </>
                )}
              </svg>
              {settingsOpen ? t('back') : t('settings')}
            </button>
          </div>
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
          />
          <ChatComposer
            attachments={
              selection && (
                <SelectionChip
                  selection={selection}
                  faviconUrl={faviconUrl}
                  onRemove={() => clearSelection()}
                />
              )
            }
            preview={
              <LivePreview
                task={state.task}
                onReveal={() => void request({ type: 'remote-preview-reveal' })}
                onStop={() => void action({ type: 'remote-stop' })}
                stopping={stopping}
              />
            }
            draft={draft}
            onDraftChange={setDraft}
            connected={connected}
            sending={sending}
            busy={chatBusy}
            onStop={() => void action({ type: 'remote-stop' })}
            stopping={stopping}
            onSend={() => void sendChat()}
            inputRef={inputRef}
          />
        </main>
      )}
    </div>
  );
}
