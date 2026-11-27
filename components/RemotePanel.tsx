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
import { ConnectView, ConnectionChip, WorkspaceFailedBanner } from './WorkspaceConnect';
import { LivePreview } from './LivePreview';
import { usePageSelection } from './usePageSelection';
import { SelectionChip } from './SelectionChip';
import { MAX_ATTACHMENTS, selectionAttachment } from '../utils/attachments';
import { useFileAttachments } from './useFileAttachments';

/** Owns the sidebar state; all browser operations still run in the background. */
export function RemotePanel() {
  const { t, errorText } = useI18n();
  const [state, setState] = useState<RemoteState>(initialRemoteState);
  const [draft, setDraft] = useState('');
  const [screen, setScreen] = useState<'loading' | 'chat' | 'settings' | 'connect'>('loading');
  const [switching, setSwitching] = useState(false);
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
  const fileAttachments = useFileAttachments(selection ? 1 : 0);

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
      if (active) setScreen(value?.configured ? 'chat' : 'connect');
    });
    return () => {
      active = false;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  // An open panel shows the conversation, so follow-ups that arrived while it
  // was closed are read now; this also clears their toolbar badge.
  const hasUnread = state.chat.some((entry) => entry.unread);
  useEffect(() => {
    if (hasUnread && screen === 'chat') void request({ type: 'remote-chat-read' });
  }, [hasUnread, screen]);

  const previousPhase = useRef(state.workspace?.connection?.phase);
  useEffect(() => {
    const phase = state.workspace?.connection?.phase;
    const previous = previousPhase.current;
    previousPhase.current = phase;
    if (phase === 'preparing' || !state.workspace?.connection) setSwitching(false);
    if (
      phase === 'connected' &&
      (previous === 'preparing' || previous === 'applying' || previous === 'idle')
    )
      setScreen((current) => (current === 'connect' ? 'chat' : current));
  }, [state.workspace?.connection?.phase, !!state.workspace?.connection]);

  // Logging out (or revoking) clears the relay configuration: leave the chat for the
  // sign-in view instead of a chat that can no longer connect.
  const wasConfigured = useRef(state.configured);
  useEffect(() => {
    if (wasConfigured.current && !state.configured)
      setScreen((current) => (current === 'chat' ? 'connect' : current));
    wasConfigured.current = state.configured;
  }, [state.configured]);

  const chatBusy = !!(state.chatBusy || state.loopActive || pending === 'remote-stop');
  const stopping = !!state.stopping || pending === 'remote-stop';

  async function sendChat() {
    const text =
      draft.trim() ||
      (fileAttachments.files.length
        ? t(
            fileAttachments.files.every((file) => file.attachment.type === 'image')
              ? 'imageMessage'
              : 'attachmentMessage',
          )
        : '');
    if (
      !state.connected ||
      !text ||
      sendingRef.current ||
      stopping ||
      state.completionPending ||
      (chatBusy && !state.steeringSupported) ||
      fileAttachments.isReading()
    )
      return;
    if (fileAttachments.files.length + (selection ? 1 : 0) > MAX_ATTACHMENTS) {
      setError('ui.error.tooManyAttachments');
      return;
    }
    const submittedDraft = draft;
    const submittedSelection = selection;
    const submittedFiles = fileAttachments.files;
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
              ...submittedFiles.map((image) => image.attachment),
            ],
          },
          ...(submittedFiles.length
            ? {
                imagePreviews: Object.fromEntries(
                  submittedFiles.flatMap((file) =>
                    file.preview ? [[file.attachment.id, file.preview]] : [],
                  ),
                ),
              }
            : {}),
          windowId: win.id,
          tabId: tab?.id,
        },
        () => revision === sendRevision.current,
      );
      if (ok) {
        setDraft((current) => (current === submittedDraft ? '' : current));
        if (submittedSelection) clearSelection(submittedSelection);
        fileAttachments.remove(submittedFiles.map((image) => image.attachment.id));
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
  const workspacePhase = state.workspace?.connection?.phase;
  const status = !state.configured
    ? workspacePhase === 'preparing' || workspacePhase === 'applying'
      ? t('workspacePhasePreparing')
      : t('notConnected')
    : !state.enabled
      ? t('disabled')
      : connected
        ? t(state.recovery === 'restored' ? 'taskConnectionRestored' : 'connected')
        : state.connecting
          ? t('connecting')
          : t('offline');
  const settingsOpen = screen === 'settings';
  const connection = state.workspace?.connection;
  const openSwitch = () => {
    setSwitching(true);
    setScreen('connect');
    setError('');
  };
  const workspaceAction = (command: RemoteRequest) => void action(command);
  // Back from settings/connect goes to chat once configured; otherwise to the connect view.
  const showBack = settingsOpen || (screen === 'connect' && state.configured);
  const visibleError = error || state.error;

  return (
    <div className={`app${connected ? ' connected' : ''}`}>
      <header className="sidebar-header">
        <div className="header-actions">
          {connection && state.configured ? (
            <ConnectionChip
              state={state}
              status={status}
              busy={pending !== null}
              onRequest={workspaceAction}
              onSwitch={openSwitch}
            />
          ) : (
            <span
              className={`connection-status${connected ? ' is-connected' : ''}`}
              title={state.relayHost}
              role="status"
            >
              <span className="status-dot" aria-hidden="true" />
              <span className="connection-status-label" title={status}>
                {status}
              </span>
            </span>
          )}
          <div className="header-tools">
            {(chatBusy || sending) && (
              <button
                id="stop-current-task"
                type="button"
                className="btn header-button header-stop"
                disabled={stopping}
                onClick={() => void action({ type: 'remote-stop' })}
              >
                <span className="header-stop-icon" aria-hidden="true" />
                {t(stopping ? 'stopping' : 'stopTask')}
              </button>
            )}
            {state.configured && screen !== 'connect' && !(chatBusy || sending) && (
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
                <span className="sr-only">{t('clearChatShort')}</span>
              </button>
            )}
            <button
              ref={settingsButtonRef}
              type="button"
              className={`btn btn-ghost header-button settings-button${showBack ? '' : ' is-icon'}`}
              title={showBack ? undefined : t('settings')}
              onClick={() => {
                setScreen(showBack ? (state.configured ? 'chat' : 'connect') : 'settings');
                setSwitching(false);
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
                {showBack ? (
                  <path d="m14 6-6 6 6 6" />
                ) : (
                  <>
                    <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
                    <circle cx="15" cy="7" r="2" />
                    <circle cx="9" cy="17" r="2" />
                  </>
                )}
              </svg>
              {showBack ? t('back') : <span className="sr-only">{t('settings')}</span>}
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
      {state.recovery && !['failed', 'restored'].includes(state.recovery) && (
        <div className="connection-feedback connection-recovery" role="status">
          {t(state.recovery === 'reconnecting' ? 'taskReconnecting' : 'taskDisconnected')}
        </div>
      )}
      {state.completionPending && state.connected && (
        <div className="connection-feedback" role="status">
          {t('taskCompletionPending')}
        </div>
      )}
      {screen === 'loading' ? (
        <main className="loading-page" role="status">
          <span className="loading loading-spinner loading-sm" />
          {t('loading')}
        </main>
      ) : screen === 'connect' ? (
        <ConnectView
          state={state}
          pending={pending !== null}
          saving={pending === 'remote-save'}
          switching={switching}
          onSwitch={openSwitch}
          onBack={() => {
            setSwitching(false);
            setScreen(state.configured ? 'chat' : 'connect');
            setError('');
          }}
          onRequest={workspaceAction}
          onSave={async (relayUrl, key) => {
            const ok = await action({ type: 'remote-save', relayUrl, key });
            if (ok) {
              setScreen('chat');
              settingsButtonRef.current?.focus();
            }
            return ok;
          }}
        />
      ) : settingsOpen ? (
        <ConnectionSettings
          state={state}
          status={status}
          onOpenConnect={() => {
            setSwitching(false);
            setScreen('connect');
          }}
          onSiteAccessChange={(command) => void action(command)}
          pending={pending !== null}
          onToggle={() => void action({ type: 'remote-set-enabled', enabled: !state.enabled })}
          onCompatibilityToggle={() =>
            void action({
              type: 'remote-compatibility-set-enabled',
              enabled: !state.compatibilityEnabled,
            })
          }
          onAgentStartToggle={(enabled, durationMinutes) =>
            void action({
              type: 'remote-agent-start-set-enabled',
              enabled,
              ...(enabled ? { durationMinutes } : {}),
            })
          }
          onDiagnosticsToggle={() =>
            void action({
              type: 'remote-diagnostics-set-enabled',
              enabled: !state.diagnosticsEnabled,
            })
          }
          onDetailedToggle={() =>
            void action({
              type: 'remote-detailed-set-enabled',
              enabled: !state.detailedDiagnostics?.enabled,
            })
          }
        />
      ) : (
        <main className="chat-panel">
          <WorkspaceFailedBanner
            state={state}
            busy={pending !== null}
            onRequest={workspaceAction}
            onSwitch={openSwitch}
          />
          {!connected && !(connection && ['failed', 'key-rejected'].includes(connection.phase)) && (
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
              <button className="btn btn-ghost" onClick={() => setScreen('connect')}>
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
            files={fileAttachments.files}
            onAddFiles={fileAttachments.addFiles}
            onRemoveFile={(id) => fileAttachments.remove([id])}
            readingAttachments={fileAttachments.reading}
            attachmentError={fileAttachments.error}
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
            steeringSupported={!!state.steeringSupported && !state.completionPending}
            stopping={stopping}
            completionPending={state.completionPending}
            onSend={() => void sendChat()}
            onStop={() => void action({ type: 'remote-stop' })}
            inputRef={inputRef}
          />
        </main>
      )}
    </div>
  );
}
