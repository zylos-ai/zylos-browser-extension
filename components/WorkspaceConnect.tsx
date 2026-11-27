import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from './LanguageProvider';
import { Brand } from './Brand';
import type { RemoteRequest, RemoteState } from '../utils/remote';
import { defaultBrowserName, workspaceEnvs } from '../utils/workspace/config';
import { connectionLabel, type WorkspaceView } from '../utils/workspace/connector';

type Agent = NonNullable<WorkspaceView['agents']>[number];
type Connection = NonNullable<WorkspaceView['connection']>;
type Step =
  | { kind: 'list' }
  | { kind: 'confirm'; agent: Agent }
  | { kind: 'name'; agent: Agent; confirm: boolean };

const isFailed = (connection?: Connection) =>
  connection?.phase === 'failed' || connection?.phase === 'key-rejected';
const isSettling = (connection?: Connection) =>
  !!connection && ['idle', 'preparing', 'applying'].includes(connection.phase);

/** Avatar from Workspace, or the first letter of the name on a soft brand circle. */
export function AgentAvatar({
  name,
  url,
  size = 'md',
}: {
  name: string;
  url?: string;
  size?: 'sm' | 'md';
}) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`agent-avatar agent-avatar-${size}`} aria-hidden="true">
      {url && !broken ? (
        <img src={url} alt="" draggable={false} onError={() => setBroken(true)} />
      ) : (
        Array.from(name.trim())[0]?.toUpperCase() || 'A'
      )}
    </span>
  );
}

export function connectionAvatar(ws?: WorkspaceView) {
  const id = ws?.connection?.agentMemberId;
  return ws?.agents?.find((agent) => agent.id === id)?.avatarUrl;
}

/** Compact failure: reason, one primary (Reconnect) and one secondary (Switch Agent). */
export function WorkspaceFailedBanner({
  state,
  busy,
  onRequest,
  onSwitch,
}: {
  state: RemoteState;
  busy: boolean;
  onRequest: (request: RemoteRequest) => void;
  onSwitch: () => void;
}) {
  const { t, errorText } = useI18n();
  const ws = state.workspace;
  const connection = ws?.connection;
  if (!ws || !connection || !isFailed(connection)) return null;
  const signedIn = ws.auth === 'signed-in';
  // Bounded-wait timeout reads as Retry / Back (to the picker).
  const timedOut = connection.error === 'ui.error.workspacePrepareTimeout';
  const reason = connection.error
    ? errorText(connection.error)
    : connection.phase === 'key-rejected'
      ? t('workspacePhaseKeyRejected')
      : t('workspacePhaseFailed');
  return (
    <div className="workspace-banner" role="alert">
      <div className="workspace-banner-copy">
        <strong>
          {timedOut ? t('workspacePrepareTimeoutTitle') : t('workspacePhaseFailed')} ·{' '}
          {connection.agentName}
        </strong>
        <span>{signedIn ? reason : t('workspaceReconnectNeedsLogin')}</span>
      </div>
      <div className="workspace-banner-actions">
        {signedIn ? (
          <>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              disabled={busy}
              onClick={() => onRequest({ type: 'workspace-reconnect' })}
            >
              {timedOut ? t('workspaceRetry') : t('workspaceReconnect')}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              disabled={busy}
              onClick={onSwitch}
            >
              {timedOut ? t('back') : t('workspaceSwitchAgent')}
            </button>
          </>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={busy}
            onClick={() => onRequest({ type: 'workspace-sign-in' })}
          >
            {t('workspaceLoginAgain')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Header chip for a Workspace connection; opens a small menu with the connection actions. */
export function ConnectionChip({
  state,
  status,
  busy,
  onRequest,
  onSwitch,
  onRename,
}: {
  state: RemoteState;
  status: string;
  busy: boolean;
  onRequest: (request: RemoteRequest) => void;
  onSwitch: () => void;
  /** Resolves true when the rename succeeded (failures are shown by the panel). */
  onRename: (browserName: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // The rename form replaces the menu items while open; undefined when closed.
  const [renameDraft, setRenameDraft] = useState<string | undefined>();
  const ref = useRef<HTMLDivElement>(null);
  const ws = state.workspace;
  const connection = ws?.connection;
  useEffect(() => {
    if (!open) {
      setRenameDraft(undefined);
      return;
    }
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !ref.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!ws || !connection) return null;
  const tone = state.connected ? 'connected' : isFailed(connection) ? 'failed' : 'pending';
  const signedIn = ws.auth === 'signed-in';
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const label = connectionLabel(connection.browserName, connection.connectionId);
  const canRename = signedIn && !!connection.connectionId && !isSettling(connection);
  const submitRename = async () => {
    const next = renameDraft?.trim();
    if (!next || busy) return;
    if (next === connection.browserName) return setOpen(false);
    if (await onRename(next)) setOpen(false);
  };
  const menuItems = (
    <>
      {canRename && (
        <button
          type="button"
          role="menuitem"
          className="connection-menu-item workspace-rename"
          disabled={busy}
          onClick={() => setRenameDraft(connection.browserName)}
        >
          {t('workspaceRename')}
        </button>
      )}
      {signedIn ? (
        <button
          type="button"
          role="menuitem"
          className="connection-menu-item"
          disabled={busy || isSettling(connection)}
          onClick={run(onSwitch)}
        >
          {t('workspaceSwitchAgent')}
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          className="connection-menu-item"
          disabled={busy}
          onClick={run(() => onRequest({ type: 'workspace-sign-in' }))}
        >
          {t('workspaceLoginAgain')}
        </button>
      )}
      {signedIn && (
        <button
          type="button"
          role="menuitem"
          className="connection-menu-item"
          disabled={busy}
          onClick={run(() => onRequest({ type: 'workspace-sign-out' }))}
        >
          {t('workspaceLogout')}
        </button>
      )}
      <hr />
      <button
        type="button"
        role="menuitem"
        className="connection-menu-item workspace-disconnect"
        disabled={busy || isSettling(connection)}
        onClick={run(() => onRequest({ type: 'remote-set-enabled', enabled: !state.enabled }))}
      >
        {t(state.enabled ? 'workspaceDisconnect' : 'workspaceReconnect')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="connection-menu-item is-danger workspace-revoke"
        disabled={busy || isSettling(connection)}
        onClick={run(() => {
          if (window.confirm(t('workspaceRevokeConfirm', { agent: connection.agentName })))
            onRequest({ type: 'workspace-revoke' });
        })}
      >
        {t('workspaceRevoke')}
      </button>
    </>
  );
  return (
    <div className="connection-chip-wrap" ref={ref}>
      <button
        type="button"
        className={`connection-chip is-${tone}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${connection.agentName} · ${status}`}
        onClick={() => setOpen((v) => !v)}
      >
        <AgentAvatar name={connection.agentName} url={connectionAvatar(ws)} size="sm" />
        <span className="connection-chip-name">{connection.agentName}</span>
        <span className="status-dot" aria-hidden="true" />
        <span className="sr-only" role="status">
          {status}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="connection-menu" role="menu" aria-label={t('connectionMenu')}>
          <div className="connection-menu-head">
            <AgentAvatar name={connection.agentName} url={connectionAvatar(ws)} />
            <div className="connection-menu-copy">
              <strong>{connection.agentName}</strong>
              <span className="connection-menu-sub">
                <span className={`connection-menu-status is-${tone}`}>{status}</span> ·{' '}
                <span className="connection-menu-browser" title={connection.connectionId}>
                  {label}
                </span>
              </span>
            </div>
          </div>
          {renameDraft !== undefined ? (
            <form
              className="connection-rename"
              onSubmit={(e) => {
                e.preventDefault();
                void submitRename();
              }}
            >
              <label className="form-field" htmlFor="workspace-rename-input">
                <span>{t('workspaceRename')}</span>
                <input
                  className="input input-sm"
                  id="workspace-rename-input"
                  value={renameDraft}
                  maxLength={100}
                  placeholder={t('workspaceBrowserNamePlaceholder')}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  autoFocus
                  required
                  disabled={busy}
                />
                <span className="settings-hint">
                  {t('workspaceRenameHint', { agent: connection.agentName })}
                </span>
              </label>
              <div className="connection-rename-actions">
                <button
                  className="btn btn-ghost btn-sm workspace-rename-cancel"
                  type="button"
                  disabled={busy}
                  onClick={() => setRenameDraft(undefined)}
                >
                  {t('cancel')}
                </button>
                <button
                  className="btn btn-primary btn-sm workspace-rename-save"
                  type="submit"
                  disabled={busy || !renameDraft.trim()}
                >
                  {t('workspaceRenameSave')}
                </button>
              </div>
            </form>
          ) : (
            menuItems
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Focused connect view: sign in to OpenMax Workspace, pick an Agent, name this browser.
 * The manual relay URL + Key form stays available behind a subtle link.
 */
export function ConnectView({
  state,
  pending,
  saving,
  switching,
  onSwitch,
  onBack,
  onRequest,
  onSave,
}: {
  state: RemoteState;
  pending: boolean;
  saving: boolean;
  switching: boolean;
  onSwitch: () => void;
  /** Leave the Switch Agent picker for the previous status view. */
  onBack?: () => void;
  onRequest: (request: RemoteRequest) => void;
  onSave: (relayUrl: string, key: string) => Promise<boolean>;
}) {
  const { t, errorText } = useI18n();
  const ws = state.workspace;
  const [step, setStep] = useState<Step>({ kind: 'list' });
  // Keep the name already chosen for this browser (e.g. when switching Agents).
  const [browserName, setBrowserName] = useState(
    () => ws?.connection?.browserName || defaultBrowserName(),
  );
  const [manualOpen, setManualOpen] = useState(!ws || (state.configured && !ws.connection));
  const connection = ws?.connection;
  const signedIn = ws?.auth === 'signed-in';
  const settling = isSettling(connection);
  const showPicker =
    signedIn && !settling && (!connection || switching) && !(isFailed(connection) && !switching);

  useEffect(() => {
    // (Re)load on every entry into the picker so it never shows a stale list; an
    // error already on screen (e.g. Agent offline) keeps its own Retry instead.
    if (showPicker && !ws?.busy && !ws?.error) onRequest({ type: 'workspace-agents' });
  }, [showPicker]);
  useEffect(() => {
    if (connection?.phase === 'preparing') setStep({ kind: 'list' });
  }, [connection?.phase]);

  const busy = pending || !!ws?.busy;
  const errorLine = (code?: string, retry?: () => void) =>
    code ? (
      <p className="workspace-error" role="alert">
        <span>{errorText(code)}</span>
        {retry && (
          <button className="link-button" type="button" disabled={busy} onClick={retry}>
            {t('workspaceRetry')}
          </button>
        )}
      </p>
    ) : null;

  let body: ReactNode = null;
  if (!ws) {
    body = null;
  } else if (!signedIn && !(connection && ws.auth === 'expired' && !isFailed(connection))) {
    body = (
      <div className="connect-hero">
        <Brand large />
        <h1 id="connect-title">
          {ws.auth === 'expired' ? t('workspaceLoginExpiredTitle') : t('connectTitle')}
        </h1>
        <p>{ws.auth === 'expired' ? t('workspaceLoginExpired') : t('connectDescription')}</p>
        <button
          className="btn btn-primary save-button connect-primary"
          type="button"
          disabled={busy}
          onClick={() => onRequest({ type: 'workspace-sign-in' })}
        >
          {busy
            ? t('workspaceSigningIn')
            : ws.auth === 'expired'
              ? t('workspaceLoginAgain')
              : t('workspaceLogin')}
        </button>
        {errorLine(ws.error)}
      </div>
    );
  } else if (connection && settling) {
    body = (
      <div className="connect-stage">
        <div className="agent-row is-static" aria-live="polite">
          <AgentAvatar name={connection.agentName} url={connectionAvatar(ws)} />
          <span className="agent-row-name">
            {connection.agentName}
            <small role="status">{t('workspacePreparing')}</small>
          </span>
          <span className="loading loading-spinner loading-sm" aria-hidden="true" />
        </div>
        {connection.phase !== 'applying' && (
          <button
            className="btn btn-ghost connect-secondary workspace-cancel"
            type="button"
            disabled={pending}
            onClick={() => onRequest({ type: 'workspace-cancel' })}
          >
            {t('workspaceCancel')}
          </button>
        )}
        {errorLine(ws.error)}
      </div>
    );
  } else if (step.kind === 'confirm' && showPicker) {
    body = (
      <div className="connect-stage">
        <AgentHeading
          agent={step.agent}
          title={t('workspaceConfirmTitle', { agent: step.agent.name })}
        />
        <ul className="capability-list">
          <li>{t('workspaceCapabilityRead')}</li>
          <li>{t('workspaceCapabilityAct')}</li>
          <li>{t('workspaceCapabilityLocal')}</li>
        </ul>
        <button
          className="btn btn-primary save-button"
          type="button"
          onClick={() => setStep({ kind: 'name', agent: step.agent, confirm: true })}
        >
          {t('workspaceAllow')}
        </button>
        <button
          className="btn btn-ghost connect-secondary"
          type="button"
          onClick={() => setStep({ kind: 'list' })}
        >
          {t('cancel')}
        </button>
      </div>
    );
  } else if (step.kind === 'name' && showPicker) {
    body = (
      <form
        className="connect-stage"
        onSubmit={(e) => {
          e.preventDefault();
          if (!browserName.trim()) return;
          onRequest({
            type: 'workspace-connect',
            agentMemberId: step.agent.id,
            agentName: step.agent.name,
            browserName: browserName.trim(),
            confirm: step.confirm,
          });
        }}
      >
        <AgentHeading agent={step.agent} title={t('workspaceBrowserName')} />
        <label className="form-field" htmlFor="workspace-browser-name">
          <input
            className="input"
            id="workspace-browser-name"
            aria-label={t('workspaceBrowserName')}
            value={browserName}
            maxLength={100}
            placeholder={t('workspaceBrowserNamePlaceholder')}
            onChange={(e) => setBrowserName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            autoFocus
            required
            disabled={busy}
          />
          <span className="settings-hint">
            {connection?.phase === 'connected'
              ? t('workspaceSwitchHint')
              : t('workspaceBrowserNameHint', { agent: step.agent.name })}
          </span>
        </label>
        <button
          className="btn btn-primary save-button"
          type="submit"
          disabled={busy || !browserName.trim()}
        >
          {t('workspaceConnect')}
        </button>
        <button
          className="btn btn-ghost connect-secondary"
          type="button"
          onClick={() => setStep({ kind: 'list' })}
        >
          {t('back')}
        </button>
        {errorLine(ws.error)}
      </form>
    );
  } else if (showPicker) {
    // Hide the current Agent only when it is actually connected (a failed one can be retried).
    const agents = ws.agents?.filter(
      (agent) => !(connection?.phase === 'connected' && agent.id === connection.agentMemberId),
    );
    const loading = ws.busy === 'agents' && !agents;
    body = (
      <div className="connect-stage">
        <div className="connect-heading">
          <h1 id="connect-title">
            {connection ? t('workspaceSwitchAgent') : t('workspaceChooseAgent')}
          </h1>
          {agents?.some((agent) => !agent.authorized) && <p>{t('workspaceChooseHint')}</p>}
        </div>
        <div
          hidden={!loading && !agents}
          className="workspace-agents"
          role="list"
          aria-label={t('workspaceChooseAgent')}
          aria-busy={loading}
        >
          {loading &&
            [0, 1, 2].map((i) => (
              <div key={i} className="agent-row is-skeleton" aria-hidden="true">
                <span className="agent-avatar agent-avatar-md" />
                <span className="skeleton-line" />
              </div>
            ))}
          {agents?.map((agent) => (
            <button
              key={agent.id}
              role="listitem"
              className={`agent-row workspace-agent${agent.status === 'offline' ? ' is-offline' : ''}`}
              type="button"
              disabled={busy || agent.status === 'offline'}
              onClick={() =>
                setStep(
                  agent.authorized
                    ? { kind: 'name', agent, confirm: false }
                    : { kind: 'confirm', agent },
                )
              }
            >
              <AgentAvatar name={agent.name} url={agent.avatarUrl} />
              <span className="agent-row-name">
                <span className="agent-row-title">
                  {agent.status && (
                    <span
                      className={`presence-dot is-${agent.status}`}
                      role="img"
                      aria-label={t(
                        agent.status === 'online'
                          ? 'workspaceOnline'
                          : agent.status === 'offline'
                            ? 'workspaceOffline'
                            : 'workspaceStatusUnknown',
                      )}
                      title={agent.status === 'unknown' ? t('workspaceStatusUnknown') : undefined}
                    />
                  )}
                  {agent.name}
                </span>
                {agent.status === 'offline' && (
                  <small className="agent-offline-hint">{t('workspaceOffline')}</small>
                )}
              </span>
              <span className={`agent-chip${agent.authorized ? ' is-authorized' : ''}`}>
                {agent.authorized ? t('workspaceAuthorized') : t('workspaceNeedsConfirm')}
              </span>
            </button>
          ))}
          {agents?.length === 0 && (
            <p className="connect-note">
              {connection?.phase === 'connected'
                ? t('workspaceNoOtherAgents')
                : t('workspaceNoOwnedAgents')}
            </p>
          )}
        </div>
        {errorLine(ws.error, ws.busy ? undefined : () => onRequest({ type: 'workspace-agents' }))}
        {connection && onBack && (
          <button
            className="btn btn-ghost connect-secondary workspace-back"
            type="button"
            onClick={onBack}
          >
            {t('back')}
          </button>
        )}
        <button
          className="link-button connect-signout"
          type="button"
          disabled={busy}
          onClick={() => onRequest({ type: 'workspace-sign-out' })}
        >
          {t('workspaceLogout')}
        </button>
      </div>
    );
  } else if (connection) {
    // Connected (or failed, shown by the banner above): a compact summary of the connection.
    body = (
      <div className="connect-stage">
        <WorkspaceFailedBanner
          state={state}
          busy={busy}
          onRequest={onRequest}
          onSwitch={onSwitch}
        />
        {!isFailed(connection) && (
          <div className="agent-row is-static">
            <AgentAvatar name={connection.agentName} url={connectionAvatar(ws)} />
            <span className="agent-row-name">
              {connection.agentName}
              <small className="connection-browser" title={connection.connectionId}>
                {connectionLabel(connection.browserName, connection.connectionId)}
              </small>
            </span>
            {state.connected && <span className="agent-chip is-authorized">{t('connected')}</span>}
          </div>
        )}
        {!isFailed(connection) && signedIn && (
          <button
            className="btn btn-outline connect-secondary"
            type="button"
            disabled={busy}
            onClick={onSwitch}
          >
            {t('workspaceSwitchAgent')}
          </button>
        )}
        {ws.auth === 'expired' && (
          <button
            className="btn btn-primary save-button"
            type="button"
            disabled={busy}
            onClick={() => onRequest({ type: 'workspace-sign-in' })}
          >
            {t('workspaceLoginAgain')}
          </button>
        )}
        {errorLine(ws.error)}
      </div>
    );
  }

  return (
    <main
      id="connect"
      className="connect-page"
      aria-labelledby={body ? 'connect-title' : undefined}
    >
      {body}
      <div className={`manual-connect${manualOpen ? ' is-open' : ''}`}>
        <button
          className="link-button manual-toggle"
          type="button"
          aria-expanded={manualOpen}
          aria-controls="manual-connect-form"
          onClick={() => setManualOpen((v) => !v)}
        >
          {t('manualConnectTitle')}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={manualOpen ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
          </svg>
        </button>
        {manualOpen && (
          <div id="manual-connect-form" className="manual-panel">
            <ManualConnectForm state={state} pending={pending} saving={saving} onSave={onSave} />
            {ws && <WorkspaceEnvSelect current={ws.baseUrl} busy={busy} onRequest={onRequest} />}
          </div>
        )}
      </div>
    </main>
  );
}

function AgentHeading({ agent, title }: { agent: Agent; title: string }) {
  return (
    <div className="agent-heading">
      <AgentAvatar name={agent.name} url={agent.avatarUrl} />
      <h1 id="connect-title">{title}</h1>
    </div>
  );
}

function ManualConnectForm({
  state,
  pending,
  saving,
  onSave,
}: {
  state: RemoteState;
  pending: boolean;
  saving: boolean;
  onSave: (relayUrl: string, key: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [relayUrl, setRelayUrl] = useState(state.relayUrl || 'ws://127.0.0.1:3802/ext');
  const [key, setKey] = useState('');
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending && relayUrl.trim() && key.trim())
          void onSave(relayUrl, key).then((ok) => {
            if (ok) setKey('');
          });
      }}
    >
      <p className="settings-hint">{t('manualConnectHint')}</p>
      <label className="form-field" htmlFor="relay-url">
        <span>{t('relayUrl')}</span>
        <input
          className="input"
          id="relay-url"
          value={relayUrl}
          onChange={(e) => setRelayUrl(e.target.value)}
          placeholder="ws://127.0.0.1:3802/ext"
          autoComplete="off"
          spellCheck={false}
          required
          disabled={pending}
        />
      </label>
      <label className="form-field" htmlFor="access-key">
        <span>{t('accessKey')}</span>
        <input
          className="input"
          id="access-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={state.keyId ? t('savedKeyPlaceholder') : t('keyPlaceholder')}
          aria-describedby="key-hint"
          autoComplete="off"
          spellCheck={false}
          required
          disabled={pending}
        />
        <span id="key-hint" className="settings-hint">
          {t('keyHint')}
        </span>
      </label>
      <button
        className="btn btn-outline save-button manual-save"
        type="submit"
        disabled={pending || !relayUrl.trim() || !key.trim()}
      >
        {saving ? t('saving') : state.enabled ? t('saveConnect') : t('saveSettings')}
      </button>
    </form>
  );
}

/** Test builds only: pick one of the build-configured Workspace environments. */
function WorkspaceEnvSelect({
  current,
  busy,
  onRequest,
}: {
  current: string;
  busy: boolean;
  onRequest: (request: RemoteRequest) => void;
}) {
  const { t } = useI18n();
  const envs = workspaceEnvs();
  if (envs.length < 2) return null;
  return (
    <div className="settings-form workspace-env-form">
      <label className="form-field" htmlFor="workspace-env">
        <span>{t('workspaceEnvironment')}</span>
        <select
          id="workspace-env"
          className="select"
          value={current}
          disabled={busy}
          onChange={(e) => onRequest({ type: 'workspace-set-url', url: e.target.value })}
        >
          {envs.map((env) => (
            <option key={env.url} value={env.url}>
              {env.name}
            </option>
          ))}
        </select>
        <span className="settings-hint">{t('workspaceEnvironmentHint')}</span>
      </label>
    </div>
  );
}
